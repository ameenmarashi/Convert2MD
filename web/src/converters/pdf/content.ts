/**
 * Content-stream interpreter.
 *
 * Walks the operator stream keeping just enough graphics state to place text:
 * CTM, text matrix, font, size, spacing and horizontal scaling. Form XObjects
 * are followed so headers, footers and templated content are not lost. The
 * result is a flat list of positioned text runs in PDF user space.
 */

import { PdfDocument, PdfPage } from './document.js';
import { PdfFont, loadFont } from './fonts.js';
import {
  Lexer,
  PdfDict,
  PdfName,
  PdfObject,
  PdfOperator,
  PdfRef,
  PdfStreamObject,
  PdfString,
} from './lexer.js';

export interface TextItem {
  x: number;
  y: number;
  width: number;
  size: number;
  text: string;
  bold: boolean;
  italic: boolean;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

interface GraphicsState {
  ctm: Matrix;
  font: PdfFont | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  leading: number;
  rise: number;
}

function cloneState(state: GraphicsState): GraphicsState {
  return { ...state, ctm: [...state.ctm] as Matrix };
}

export function extractPageText(doc: PdfDocument, page: PdfPage): TextItem[] {
  const items: TextItem[] = [];
  const content = doc.pageContent(page);
  if (content.length === 0) return items;

  const interpreter = new ContentInterpreter(doc, items);
  interpreter.run(content, page.resources, IDENTITY, 0);
  return items;
}

class ContentInterpreter {
  private readonly fontCache = new Map<string, PdfFont>();
  private readonly activeForms = new Set<string>();

  constructor(private readonly doc: PdfDocument, private readonly items: TextItem[]) {}

  run(content: Uint8Array, resources: PdfDict | null, baseCtm: Matrix, depth: number): void {
    if (depth > 8) return;

    const lexer = new Lexer(content, 0);
    let operands: PdfObject[] = [];
    const stack: GraphicsState[] = [];

    let state: GraphicsState = {
      ctm: baseCtm,
      font: null,
      fontSize: 0,
      charSpacing: 0,
      wordSpacing: 0,
      hscale: 1,
      leading: 0,
      rise: 0,
    };

    let tm: Matrix = [...IDENTITY] as Matrix;
    let tlm: Matrix = [...IDENTITY] as Matrix;

    const num = (index: number): number => {
      const value = operands[operands.length - index];
      return typeof value === 'number' ? value : 0;
    };

    for (;;) {
      const token = lexer.next();
      if (token === undefined) break;

      if (!(token instanceof PdfOperator)) {
        operands.push(token);
        if (operands.length > 64) operands.shift();
        continue;
      }

      switch (token.op) {
        case 'q':
          stack.push(cloneState(state));
          break;
        case 'Q': {
          const restored = stack.pop();
          if (restored) state = restored;
          break;
        }
        case 'cm':
          state.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], state.ctm);
          break;
        case 'BT':
          tm = [...IDENTITY] as Matrix;
          tlm = [...IDENTITY] as Matrix;
          break;
        case 'ET':
          break;
        case 'Tf': {
          const size = num(1);
          const nameOperand = operands[operands.length - 2];
          state.fontSize = size;
          if (nameOperand instanceof PdfName) state.font = this.lookupFont(resources, nameOperand.name);
          break;
        }
        case 'Td':
          tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
          tm = [...tlm] as Matrix;
          break;
        case 'TD':
          state.leading = -num(1);
          tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
          tm = [...tlm] as Matrix;
          break;
        case 'Tm':
          tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
          tm = [...tlm] as Matrix;
          break;
        case 'T*':
          tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = [...tlm] as Matrix;
          break;
        case 'TL':
          state.leading = num(1);
          break;
        case 'Tc':
          state.charSpacing = num(1);
          break;
        case 'Tw':
          state.wordSpacing = num(1);
          break;
        case 'Tz':
          state.hscale = num(1) / 100;
          break;
        case 'Ts':
          state.rise = num(1);
          break;
        case 'Tr':
        case 'gs':
          break;
        case 'Tj': {
          const value = operands[operands.length - 1];
          if (value instanceof PdfString) tm = this.showText(state, tm, [value]);
          break;
        }
        case "'": {
          tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = [...tlm] as Matrix;
          const value = operands[operands.length - 1];
          if (value instanceof PdfString) tm = this.showText(state, tm, [value]);
          break;
        }
        case '"': {
          state.wordSpacing = num(3);
          state.charSpacing = num(2);
          tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = [...tlm] as Matrix;
          const value = operands[operands.length - 1];
          if (value instanceof PdfString) tm = this.showText(state, tm, [value]);
          break;
        }
        case 'TJ': {
          const array = operands[operands.length - 1];
          if (Array.isArray(array)) tm = this.showText(state, tm, array);
          break;
        }
        case 'Do': {
          const nameOperand = operands[operands.length - 1];
          if (nameOperand instanceof PdfName) this.runXObject(resources, nameOperand.name, state, depth);
          break;
        }
        case 'BI':
          skipInlineImage(lexer);
          break;
        default:
          break;
      }
      operands = [];
    }
  }

  private lookupFont(resources: PdfDict | null, name: string): PdfFont | null {
    const fonts = this.doc.dictGet(resources, 'Font');
    if (!(fonts instanceof Map)) return null;
    const ref = (fonts as PdfDict).get(name);
    const cacheKey = ref instanceof PdfRef ? ref.key : `${name}@${(fonts as PdfDict).size}`;

    const cached = this.fontCache.get(cacheKey);
    if (cached) return cached;

    const dict = this.doc.resolve(ref ?? null);
    if (!(dict instanceof Map)) return null;

    const font = loadFont(this.doc, dict as PdfDict);
    this.fontCache.set(cacheKey, font);
    return font;
  }

  private runXObject(resources: PdfDict | null, name: string, state: GraphicsState, depth: number): void {
    const xobjects = this.doc.dictGet(resources, 'XObject');
    if (!(xobjects instanceof Map)) return;

    const ref = (xobjects as PdfDict).get(name);
    const key = ref instanceof PdfRef ? ref.key : `${name}@${depth}`;
    if (this.activeForms.has(key)) return;

    const stream = this.doc.resolve(ref ?? null);
    if (!(stream instanceof PdfStreamObject)) return;

    const subtype = this.doc.dictGet(stream.dict, 'Subtype');
    if (!(subtype instanceof PdfName) || subtype.name !== 'Form') return;

    const matrixValue = this.doc.dictGet(stream.dict, 'Matrix');
    let ctm = state.ctm;
    if (Array.isArray(matrixValue) && matrixValue.length === 6) {
      const m = matrixValue.map((v) => {
        const resolved = this.doc.resolve(v);
        return typeof resolved === 'number' ? resolved : 0;
      }) as Matrix;
      ctm = multiply(m, ctm);
    }

    const formResources = this.doc.dictGet(stream.dict, 'Resources');
    const data = this.doc.streamData(stream, ref instanceof PdfRef ? ref : undefined);

    this.activeForms.add(key);
    this.run(data, formResources instanceof Map ? (formResources as PdfDict) : resources, ctm, depth + 1);
    this.activeForms.delete(key);
  }

  private showText(state: GraphicsState, tmIn: Matrix, parts: PdfObject[]): Matrix {
    let tm = tmIn;
    const font = state.font;
    if (!font || state.fontSize === 0) return tm;

    const trmOf = (matrix: Matrix): Matrix =>
      multiply([state.fontSize * state.hscale, 0, 0, state.fontSize, 0, state.rise], multiply(matrix, state.ctm));

    const startTrm = trmOf(tm);
    const size = Math.hypot(startTrm[2], startTrm[3]);
    let text = '';

    for (const part of parts) {
      if (typeof part === 'number') {
        const shift = (-part / 1000) * state.fontSize * state.hscale;
        tm = multiply([1, 0, 0, 1, shift, 0], tm);
        // A kern wider than a fifth of an em is how most producers write a space.
        if (shift > state.fontSize * 0.18 && text && !text.endsWith(' ')) text += ' ';
        continue;
      }
      if (!(part instanceof PdfString)) continue;

      for (const glyph of font.decode(part.bytes)) {
        text += glyph.text;
        const isSpaceCode = glyph.code === 32;
        const advance =
          ((glyph.width / 1000) * state.fontSize + state.charSpacing + (isSpaceCode ? state.wordSpacing : 0)) *
          state.hscale;
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
      }
    }

    if (text.trim().length === 0) return tm;

    const endTrm = trmOf(tm);
    this.items.push({
      x: startTrm[4],
      y: startTrm[5],
      width: Math.max(0, Math.hypot(endTrm[4] - startTrm[4], endTrm[5] - startTrm[5])),
      size: size || state.fontSize,
      text,
      bold: font.bold,
      italic: font.italic,
    });
    return tm;
  }
}

/** Inline images embed raw bytes between `ID` and `EI`; step over them. */
function skipInlineImage(lexer: Lexer): void {
  const bytes = lexer.bytes;
  let i = lexer.pos;

  while (i + 1 < bytes.length) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44) {
      i += 2;
      break;
    }
    i++;
  }
  if (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;

  while (i + 1 < bytes.length) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      (i === 0 || bytes[i - 1] === 0x20 || bytes[i - 1] === 0x0a || bytes[i - 1] === 0x0d) &&
      (i + 2 >= bytes.length || bytes[i + 2] === 0x20 || bytes[i + 2] === 0x0a || bytes[i + 2] === 0x0d)
    ) {
      lexer.pos = i + 2;
      return;
    }
    i++;
  }
  lexer.pos = bytes.length;
}
