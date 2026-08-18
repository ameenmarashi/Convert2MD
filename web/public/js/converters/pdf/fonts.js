/** Font handling: code → Unicode and code → advance width. */
import { baseEncodingTable, glyphNameToUnicode } from './encoding.js';
import { Lexer, PdfName, PdfOperator, PdfStreamObject, PdfString, PdfRef } from './lexer.js';
export class PdfFont {
    constructor(name, bold, italic, serif, twoByte, toUnicode, simpleTable, widths, defaultWidth) {
        this.name = name;
        this.bold = bold;
        this.italic = italic;
        this.serif = serif;
        this.twoByte = twoByte;
        this.toUnicode = toUnicode;
        this.simpleTable = simpleTable;
        this.widths = widths;
        this.defaultWidth = defaultWidth;
    }
    decode(bytes) {
        const glyphs = [];
        const step = this.twoByte ? 2 : 1;
        for (let i = 0; i + step <= bytes.length; i += step) {
            const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
            glyphs.push({ code, text: this.textFor(code), width: this.widthFor(code) });
        }
        if (step === 2 && bytes.length % 2 === 1) {
            const code = bytes[bytes.length - 1];
            glyphs.push({ code, text: this.textFor(code), width: this.widthFor(code) });
        }
        return glyphs;
    }
    textFor(code) {
        const mapped = this.toUnicode.get(code);
        if (mapped !== undefined)
            return mapped;
        if (this.simpleTable)
            return this.simpleTable[code] ?? '';
        // Identity-encoded CID font without a ToUnicode map: nothing reliable to show.
        return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
    }
    widthFor(code) {
        return this.widths.get(code) ?? this.defaultWidth;
    }
}
export function loadFont(doc, dict) {
    const subtype = nameOf(doc.dictGet(dict, 'Subtype')) ?? '';
    const baseFont = nameOf(doc.dictGet(dict, 'BaseFont')) ?? '';
    const lowerName = baseFont.toLowerCase();
    const toUnicode = readToUnicode(doc, dict);
    if (subtype === 'Type0') {
        const descendants = doc.dictGet(dict, 'DescendantFonts');
        const descendant = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
        const cid = descendant instanceof Map ? descendant : null;
        const defaultWidth = numberOf(doc.dictGet(cid, 'DW'), 1000);
        const widths = readCidWidths(doc, cid);
        const flags = readFlags(doc, cid);
        return new PdfFont(baseFont, isBold(lowerName, doc, cid), isItalic(lowerName, flags), (flags & 2) !== 0, true, toUnicode, null, widths, defaultWidth);
    }
    const flags = readFlags(doc, dict);
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    const table = readSimpleEncoding(doc, dict, symbolic);
    const { widths, defaultWidth } = readSimpleWidths(doc, dict, subtype);
    return new PdfFont(baseFont, isBold(lowerName, doc, dict), isItalic(lowerName, flags), (flags & 2) !== 0, false, toUnicode, table, widths, defaultWidth);
}
function readFlags(doc, dict) {
    const descriptor = doc.dictGet(dict, 'FontDescriptor');
    if (!(descriptor instanceof Map))
        return 0;
    return numberOf(doc.dictGet(descriptor, 'Flags'), 0);
}
function isBold(lowerName, doc, dict) {
    if (/bold|black|heavy|semibold|[-,]bd\b/.test(lowerName))
        return true;
    const descriptor = doc.dictGet(dict, 'FontDescriptor');
    if (descriptor instanceof Map) {
        const weight = numberOf(doc.dictGet(descriptor, 'FontWeight'), 400);
        if (weight >= 600)
            return true;
        const stemV = numberOf(doc.dictGet(descriptor, 'StemV'), 0);
        if (stemV >= 120)
            return true;
    }
    return false;
}
function isItalic(lowerName, flags) {
    return /italic|oblique|[-,]it\b/.test(lowerName) || (flags & 64) !== 0;
}
function readSimpleEncoding(doc, dict, symbolic) {
    const encoding = doc.dictGet(dict, 'Encoding');
    let baseName = symbolic ? 'StandardEncoding' : 'WinAnsiEncoding';
    let differences = [];
    if (encoding instanceof PdfName) {
        baseName = encoding.name;
    }
    else if (encoding instanceof Map) {
        const base = doc.dictGet(encoding, 'BaseEncoding');
        if (base instanceof PdfName)
            baseName = base.name;
        const diff = doc.dictGet(encoding, 'Differences');
        if (Array.isArray(diff))
            differences = diff;
    }
    const table = baseEncodingTable(baseName);
    let code = 0;
    for (const entry of differences) {
        const value = doc.resolve(entry);
        if (typeof value === 'number') {
            code = value;
        }
        else if (value instanceof PdfName) {
            if (code >= 0 && code < 256)
                table[code] = glyphNameToUnicode(value.name);
            code++;
        }
    }
    return table;
}
function readSimpleWidths(doc, dict, subtype) {
    const widths = new Map();
    const first = numberOf(doc.dictGet(dict, 'FirstChar'), 0);
    const list = doc.dictGet(dict, 'Widths');
    let scale = 1;
    if (subtype === 'Type3') {
        const matrix = doc.dictGet(dict, 'FontMatrix');
        if (Array.isArray(matrix) && typeof doc.resolve(matrix[0]) === 'number') {
            scale = doc.resolve(matrix[0]) * 1000;
        }
    }
    if (Array.isArray(list)) {
        list.forEach((entry, index) => {
            const value = doc.resolve(entry);
            if (typeof value === 'number')
                widths.set(first + index, value * scale);
        });
    }
    const descriptor = doc.dictGet(dict, 'FontDescriptor');
    let defaultWidth = 500;
    if (descriptor instanceof Map) {
        const missing = doc.dictGet(descriptor, 'MissingWidth');
        if (typeof missing === 'number' && missing > 0)
            defaultWidth = missing;
    }
    if (widths.size === 0) {
        // No metrics at all: approximate a proportional Latin face.
        widths.set(32, 278);
        for (let c = 33; c < 127; c++)
            widths.set(c, /[ijltfr.,;:'"|!]/.test(String.fromCharCode(c)) ? 280 : 556);
        for (let c = 65; c <= 90; c++)
            widths.set(c, 667);
    }
    return { widths, defaultWidth };
}
function readCidWidths(doc, cid) {
    const widths = new Map();
    const w = doc.dictGet(cid, 'W');
    if (!Array.isArray(w))
        return widths;
    let i = 0;
    while (i < w.length) {
        const start = doc.resolve(w[i]);
        if (typeof start !== 'number')
            break;
        const second = doc.resolve(w[i + 1]);
        if (Array.isArray(second)) {
            second.forEach((entry, index) => {
                const value = doc.resolve(entry);
                if (typeof value === 'number')
                    widths.set(start + index, value);
            });
            i += 2;
        }
        else if (typeof second === 'number') {
            const value = doc.resolve(w[i + 2]);
            if (typeof value !== 'number')
                break;
            const end = Math.min(second, start + 65535);
            for (let code = start; code <= end; code++)
                widths.set(code, value);
            i += 3;
        }
        else {
            break;
        }
    }
    return widths;
}
function readToUnicode(doc, dict) {
    const value = dict.get('ToUnicode');
    const stream = doc.resolve(value ?? null);
    if (!(stream instanceof PdfStreamObject))
        return new Map();
    const data = doc.streamData(stream, value instanceof PdfRef ? value : undefined);
    if (data.length === 0)
        return new Map();
    try {
        return parseCMap(data);
    }
    catch {
        return new Map();
    }
}
/** Parse the bfchar/bfrange sections of a ToUnicode CMap. */
export function parseCMap(data) {
    const map = new Map();
    const lexer = new Lexer(data, 0);
    let operands = [];
    for (;;) {
        const token = lexer.next();
        if (token === undefined)
            break;
        if (!(token instanceof PdfOperator)) {
            operands.push(token);
            if (operands.length > 600)
                operands = operands.slice(-600);
            continue;
        }
        switch (token.op) {
            case 'endbfchar': {
                for (let i = 0; i + 1 < operands.length; i += 2) {
                    const src = operands[i];
                    const dst = operands[i + 1];
                    if (src instanceof PdfString) {
                        if (dst instanceof PdfString)
                            map.set(codeOf(src), utf16BE(dst.bytes));
                        else if (dst instanceof PdfName) {
                            const text = glyphNameToUnicode(dst.name);
                            if (text)
                                map.set(codeOf(src), text);
                        }
                    }
                }
                operands = [];
                break;
            }
            case 'endbfrange': {
                for (let i = 0; i + 2 < operands.length; i += 3) {
                    const lo = operands[i];
                    const hi = operands[i + 1];
                    const dst = operands[i + 2];
                    if (!(lo instanceof PdfString) || !(hi instanceof PdfString))
                        continue;
                    const start = codeOf(lo);
                    const end = Math.min(codeOf(hi), start + 65535);
                    if (Array.isArray(dst)) {
                        dst.forEach((entry, index) => {
                            if (entry instanceof PdfString)
                                map.set(start + index, utf16BE(entry.bytes));
                        });
                    }
                    else if (dst instanceof PdfString) {
                        const base = utf16BE(dst.bytes);
                        const codePoints = [...base];
                        for (let code = start; code <= end; code++) {
                            if (codePoints.length === 0)
                                break;
                            const last = codePoints[codePoints.length - 1].codePointAt(0) ?? 0;
                            const shifted = last + (code - start);
                            codePoints[codePoints.length - 1] = safeChar(shifted);
                            map.set(code, codePoints.join(''));
                        }
                    }
                }
                operands = [];
                break;
            }
            case 'endcodespacerange':
            case 'endcidrange':
            case 'endcidchar':
            case 'endnotdefrange':
                operands = [];
                break;
            case 'begincodespacerange':
            case 'beginbfchar':
            case 'beginbfrange':
            case 'begincidrange':
            case 'begincidchar':
                operands = [];
                break;
            default:
                break;
        }
    }
    return map;
}
function codeOf(value) {
    let code = 0;
    for (const byte of value.bytes)
        code = (code << 8) | byte;
    return code >>> 0;
}
function utf16BE(bytes) {
    if (bytes.length === 1)
        return String.fromCharCode(bytes[0]);
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2)
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
}
function safeChar(code) {
    if (code < 0 || code > 0x10ffff)
        return '';
    try {
        return String.fromCodePoint(code);
    }
    catch {
        return '';
    }
}
function nameOf(value) {
    return value instanceof PdfName ? value.name : null;
}
function numberOf(value, fallback) {
    return typeof value === 'number' ? value : fallback;
}
//# sourceMappingURL=fonts.js.map