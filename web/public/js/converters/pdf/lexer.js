/** PDF object model and tokenizer (PDF 32000-1, clause 7.3). */
export class PdfName {
    constructor(name) {
        this.name = name;
    }
}
export class PdfRef {
    constructor(num, gen) {
        this.num = num;
        this.gen = gen;
    }
    get key() {
        return `${this.num}:${this.gen}`;
    }
}
export class PdfString {
    constructor(bytes) {
        this.bytes = bytes;
    }
}
export class PdfOperator {
    constructor(op) {
        this.op = op;
    }
}
export class PdfStreamObject {
    constructor(dict, raw) {
        this.dict = dict;
        this.raw = raw;
    }
}
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
export function isWhitespace(byte) {
    return WHITESPACE.has(byte);
}
export function isDelimiter(byte) {
    return DELIMITERS.has(byte);
}
export function isRegular(byte) {
    return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}
export class Lexer {
    constructor(bytes, start = 0) {
        this.bytes = bytes;
        this.pos = start;
    }
    get atEnd() {
        return this.pos >= this.bytes.length;
    }
    skipWhitespace() {
        while (this.pos < this.bytes.length) {
            const byte = this.bytes[this.pos];
            if (WHITESPACE.has(byte)) {
                this.pos++;
            }
            else if (byte === 0x25) {
                // comment runs to end of line
                while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) {
                    this.pos++;
                }
            }
            else {
                return;
            }
        }
    }
    peekByte() {
        return this.pos < this.bytes.length ? this.bytes[this.pos] : -1;
    }
    /** Read the next raw token: object, operator keyword, or `null` at EOF. */
    next() {
        this.skipWhitespace();
        if (this.atEnd)
            return undefined;
        const byte = this.bytes[this.pos];
        if (byte === 0x2f)
            return this.readName();
        if (byte === 0x28)
            return this.readLiteralString();
        if (byte === 0x3c) {
            if (this.bytes[this.pos + 1] === 0x3c) {
                this.pos += 2;
                return this.readDictionary();
            }
            return this.readHexString();
        }
        if (byte === 0x5b) {
            this.pos++;
            return this.readArray();
        }
        if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7b || byte === 0x7d) {
            this.pos++;
            return new PdfOperator(String.fromCharCode(byte));
        }
        if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
            return this.readNumberOrRef();
        }
        return this.readKeyword();
    }
    readKeyword() {
        const start = this.pos;
        while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]))
            this.pos++;
        if (this.pos === start) {
            this.pos++;
            return new PdfOperator(String.fromCharCode(this.bytes[start]));
        }
        const word = latin1(this.bytes, start, this.pos);
        if (word === 'true')
            return true;
        if (word === 'false')
            return false;
        if (word === 'null')
            return null;
        return new PdfOperator(word);
    }
    readName() {
        this.pos++;
        let out = '';
        while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) {
            const byte = this.bytes[this.pos];
            if (byte === 0x23 && this.pos + 2 < this.bytes.length) {
                const hex = latin1(this.bytes, this.pos + 1, this.pos + 3);
                const code = parseInt(hex, 16);
                if (Number.isFinite(code)) {
                    out += String.fromCharCode(code);
                    this.pos += 3;
                    continue;
                }
            }
            out += String.fromCharCode(byte);
            this.pos++;
        }
        return new PdfName(out);
    }
    readNumberOrRef() {
        const first = this.readNumber();
        if (!Number.isInteger(first) || first < 0)
            return first;
        const save = this.pos;
        this.skipWhitespace();
        const genStart = this.pos;
        if (this.pos < this.bytes.length && this.bytes[this.pos] >= 0x30 && this.bytes[this.pos] <= 0x39) {
            const gen = this.readNumber();
            if (Number.isInteger(gen)) {
                this.skipWhitespace();
                if (this.bytes[this.pos] === 0x52 && !isRegular(this.bytes[this.pos + 1] ?? 0x20)) {
                    this.pos++;
                    return new PdfRef(first, gen);
                }
            }
            this.pos = genStart;
        }
        this.pos = save;
        return first;
    }
    readNumber() {
        const start = this.pos;
        if (this.bytes[this.pos] === 0x2b || this.bytes[this.pos] === 0x2d)
            this.pos++;
        while (this.pos < this.bytes.length) {
            const byte = this.bytes[this.pos];
            if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d || byte === 0x2b || byte === 0x45 || byte === 0x65) {
                this.pos++;
            }
            else {
                break;
            }
        }
        const value = parseFloat(latin1(this.bytes, start, this.pos));
        return Number.isFinite(value) ? value : 0;
    }
    readLiteralString() {
        this.pos++;
        const out = [];
        let depth = 1;
        while (this.pos < this.bytes.length) {
            let byte = this.bytes[this.pos++];
            if (byte === 0x5c) {
                const escape = this.bytes[this.pos++];
                switch (escape) {
                    case 0x6e:
                        out.push(0x0a);
                        break;
                    case 0x72:
                        out.push(0x0d);
                        break;
                    case 0x74:
                        out.push(0x09);
                        break;
                    case 0x62:
                        out.push(0x08);
                        break;
                    case 0x66:
                        out.push(0x0c);
                        break;
                    case 0x28:
                        out.push(0x28);
                        break;
                    case 0x29:
                        out.push(0x29);
                        break;
                    case 0x5c:
                        out.push(0x5c);
                        break;
                    case 0x0d:
                        if (this.bytes[this.pos] === 0x0a)
                            this.pos++;
                        break;
                    case 0x0a:
                        break;
                    default:
                        if (escape >= 0x30 && escape <= 0x37) {
                            let code = escape - 0x30;
                            for (let i = 0; i < 2; i++) {
                                const digit = this.bytes[this.pos];
                                if (digit >= 0x30 && digit <= 0x37) {
                                    code = code * 8 + (digit - 0x30);
                                    this.pos++;
                                }
                                else
                                    break;
                            }
                            out.push(code & 0xff);
                        }
                        else {
                            out.push(escape);
                        }
                        break;
                }
                continue;
            }
            if (byte === 0x28)
                depth++;
            else if (byte === 0x29) {
                depth--;
                if (depth === 0)
                    break;
            }
            out.push(byte);
        }
        return new PdfString(Uint8Array.from(out));
    }
    readHexString() {
        this.pos++;
        const digits = [];
        while (this.pos < this.bytes.length) {
            const byte = this.bytes[this.pos++];
            if (byte === 0x3e)
                break;
            const value = hexValue(byte);
            if (value >= 0)
                digits.push(value);
        }
        if (digits.length % 2 === 1)
            digits.push(0);
        const out = new Uint8Array(digits.length / 2);
        for (let i = 0; i < out.length; i++)
            out[i] = (digits[i * 2] << 4) | digits[i * 2 + 1];
        return new PdfString(out);
    }
    readArray() {
        const out = [];
        for (;;) {
            this.skipWhitespace();
            if (this.atEnd)
                break;
            if (this.bytes[this.pos] === 0x5d) {
                this.pos++;
                break;
            }
            const value = this.next();
            if (value === undefined)
                break;
            if (value instanceof PdfOperator) {
                if (value.op === ']')
                    break;
                continue;
            }
            out.push(value);
        }
        return out;
    }
    readDictionary() {
        const dict = new Map();
        for (;;) {
            this.skipWhitespace();
            if (this.atEnd)
                break;
            if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
                this.pos += 2;
                break;
            }
            const key = this.next();
            if (key === undefined)
                break;
            if (!(key instanceof PdfName)) {
                if (key instanceof PdfOperator && key.op === '>')
                    continue;
                continue;
            }
            const value = this.next();
            if (value === undefined)
                break;
            if (value instanceof PdfOperator)
                continue;
            dict.set(key.name, value);
        }
        return dict;
    }
}
function hexValue(byte) {
    if (byte >= 0x30 && byte <= 0x39)
        return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46)
        return byte - 0x37;
    if (byte >= 0x61 && byte <= 0x66)
        return byte - 0x57;
    return -1;
}
export function latin1(bytes, start = 0, end = bytes.length) {
    let out = '';
    for (let i = start; i < end; i++)
        out += String.fromCharCode(bytes[i]);
    return out;
}
/** Decode a PDF text string: UTF-16BE with BOM, else PDFDocEncoding ≈ Latin-1. */
export function decodeTextString(value) {
    const bytes = value.bytes;
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        let out = '';
        for (let i = 2; i + 1 < bytes.length; i += 2)
            out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        return out;
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    return latin1(bytes);
}
//# sourceMappingURL=lexer.js.map