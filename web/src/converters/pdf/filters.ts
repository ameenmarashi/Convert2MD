/** PDF stream filters (PDF 32000-1, clause 7.4) and predictor undoing. */

import { inflate } from '../../core/inflate.js';
import { PdfDict, PdfName, PdfObject } from './lexer.js';

export type Resolver = (value: PdfObject) => PdfObject;

export function decodeStream(
  dict: PdfDict,
  raw: Uint8Array,
  resolve: Resolver
): { data: Uint8Array; imageFilter: string | null } {
  const filters = toArray(resolve(dict.get('Filter') ?? dict.get('F') ?? null), resolve)
    .map((f) => (f instanceof PdfName ? f.name : ''))
    .filter(Boolean);
  const parmsRaw = resolve(dict.get('DecodeParms') ?? dict.get('DP') ?? null);
  const parms = toArray(parmsRaw, resolve);

  let data = raw;
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i];
    const parm = resolve(parms[i] ?? null);
    const parmDict = parm instanceof Map ? (parm as PdfDict) : null;

    switch (filter) {
      case 'FlateDecode':
      case 'Fl':
        data = applyPredictor(inflate(data), parmDict, resolve);
        break;
      case 'LZWDecode':
      case 'LZW': {
        const early = parmDict ? numberOf(resolve(parmDict.get('EarlyChange') ?? null), 1) : 1;
        data = applyPredictor(lzwDecode(data, early), parmDict, resolve);
        break;
      }
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLengthDecode(data);
        break;
      case 'DCTDecode':
      case 'DCT':
      case 'JPXDecode':
      case 'JBIG2Decode':
      case 'CCITTFaxDecode':
      case 'CCF':
        return { data, imageFilter: filter };
      case 'Crypt':
        break;
      default:
        break;
    }
  }
  return { data, imageFilter: null };
}

function toArray(value: PdfObject, resolve: Resolver): PdfObject[] {
  const resolved = resolve(value);
  if (resolved === null || resolved === undefined) return [];
  return Array.isArray(resolved) ? resolved : [resolved];
}

function numberOf(value: PdfObject, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function applyPredictor(data: Uint8Array, parms: PdfDict | null, resolve: Resolver): Uint8Array {
  if (!parms) return data;
  const predictor = numberOf(resolve(parms.get('Predictor') ?? null), 1);
  if (predictor <= 1) return data;

  const colors = numberOf(resolve(parms.get('Colors') ?? null), 1);
  const bpc = numberOf(resolve(parms.get('BitsPerComponent') ?? null), 8);
  const columns = numberOf(resolve(parms.get('Columns') ?? null), 1);
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) return tiffPredictor(data, colors, bpc, columns);

  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const row = out.subarray(r * rowLength, (r + 1) * rowLength);
    row.set(src);

    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      switch (type) {
        case 1: row[i] = (row[i] + left) & 0xff; break;
        case 2: row[i] = (row[i] + up) & 0xff; break;
        case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff; break;
        default: break;
      }
    }
    prev = row;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function tiffPredictor(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  if (bpc !== 8) return data;
  const rowLength = colors * columns;
  const rows = Math.floor(data.length / rowLength);
  for (let r = 0; r < rows; r++) {
    const offset = r * rowLength;
    for (let i = colors; i < rowLength; i++) {
      data[offset + i] = (data[offset + i] + data[offset + i - colors]) & 0xff;
    }
  }
  return data;
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let digit = -1;
  for (const byte of data) {
    if (byte === 0x3e) break;
    let value = -1;
    if (byte >= 0x30 && byte <= 0x39) value = byte - 0x30;
    else if (byte >= 0x41 && byte <= 0x46) value = byte - 0x37;
    else if (byte >= 0x61 && byte <= 0x66) value = byte - 0x57;
    else continue;
    if (digit < 0) digit = value;
    else {
      out.push((digit << 4) | value);
      digit = -1;
    }
  }
  if (digit >= 0) out.push(digit << 4);
  return Uint8Array.from(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;

  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;

  for (; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0x7e) break;
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group.length = 0;
    }
  }

  if (group.length > 1) {
    const missing = 5 - group.length;
    for (let j = 0; j < missing; j++) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Uint8Array.from(out);
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let j = 0; j <= length; j++) out.push(data[i++] ?? 0);
    } else {
      const byte = data[i++] ?? 0;
      for (let j = 0; j < 257 - length; j++) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

export function lzwDecode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  const dictionary: number[][] = [];
  const reset = (): void => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i++) dictionary.push([i]);
    dictionary.push([], []);
  };
  reset();

  let codeWidth = 9;
  let previous: number[] | null = null;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 8) | data[i];
    bitCount += 8;

    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;

      if (code === 256) {
        reset();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);

      let entry: number[];
      if (code < dictionary.length && dictionary[code].length > 0) {
        entry = dictionary[code];
      } else if (previous) {
        entry = [...previous, previous[0]];
      } else {
        continue;
      }

      out.push(...entry);
      if (previous) dictionary.push([...previous, entry[0]]);
      previous = entry;

      const limit = dictionary.length + earlyChange;
      if (limit >= 512 && codeWidth === 9) codeWidth = 10;
      else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
      else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
    }
  }
  return Uint8Array.from(out);
}
