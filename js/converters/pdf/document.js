/**
 * PDF document loader.
 *
 * Rather than trusting the cross-reference table — which is wrong or truncated
 * in a surprising share of real files — every `N G obj` header is scanned
 * directly, later definitions winning (that is what an incremental update
 * means). Object streams are expanded afterwards, so compressed-xref PDFs load
 * through the same path.
 */
import { decodeStream } from './filters.js';
import { Decryptor, DecryptionError } from './crypt.js';
import { Lexer, PdfName, PdfOperator, PdfRef, PdfStreamObject, PdfString, decodeTextString, isRegular, latin1, } from './lexer.js';
export class PdfDocument {
    constructor(bytes) {
        this.bytes = bytes;
        this.warnings = [];
        this.pages = [];
        this.offsets = new Map();
        this.cache = new Map();
        this.compressed = new Map();
        this.decryptor = null;
        this.trailer = new Map();
        this.objStmExpanded = false;
    }
    static parse(bytes) {
        const doc = new PdfDocument(bytes);
        doc.scanObjects();
        doc.readTrailer();
        doc.setUpDecryption();
        doc.expandObjectStreams();
        doc.buildPages();
        return doc;
    }
    get pageCount() {
        return this.pages.length;
    }
    info() {
        const meta = {};
        const info = this.resolve(this.trailer.get('Info') ?? null);
        if (!(info instanceof Map))
            return meta;
        const read = (key) => {
            const value = this.resolve(info.get(key) ?? null);
            return value instanceof PdfString ? decodeTextString(value).trim() : '';
        };
        const map = [
            ['title', 'Title'],
            ['author', 'Author'],
            ['subject', 'Subject'],
            ['keywords', 'Keywords'],
            ['creator', 'Creator'],
            ['producer', 'Producer'],
        ];
        for (const [key, pdfKey] of map) {
            const value = read(pdfKey);
            if (value)
                meta[key] = value;
        }
        const created = read('CreationDate');
        if (created)
            meta.created = formatPdfDate(created);
        const modified = read('ModDate');
        if (modified)
            meta.modified = formatPdfDate(modified);
        return meta;
    }
    resolve(value) {
        let current = value;
        let guard = 0;
        while (current instanceof PdfRef && guard++ < 64)
            current = this.getObject(current.num, current.gen);
        return current;
    }
    dictGet(dict, ...keys) {
        if (!dict)
            return null;
        for (const key of keys) {
            if (dict.has(key))
                return this.resolve(dict.get(key) ?? null);
        }
        return null;
    }
    /** Fully decoded bytes for a stream object. */
    streamData(stream, owner) {
        let raw = stream.raw;
        if (this.decryptor && owner) {
            const type = this.dictGet(stream.dict, 'Type');
            const isXref = type instanceof PdfName && type.name === 'XRef';
            if (!isXref)
                raw = this.decryptor.decrypt(raw, owner.num, owner.gen);
        }
        try {
            return decodeStream(stream.dict, raw, (o) => this.resolve(o)).data;
        }
        catch (err) {
            this.warnings.push(`Could not decode a stream: ${err.message}`);
            return new Uint8Array(0);
        }
    }
    /* ---------------------------------------------------------- object map */
    scanObjects() {
        const bytes = this.bytes;
        for (let i = 0; i + 2 < bytes.length; i++) {
            if (bytes[i] !== 0x6f || bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a)
                continue; // "obj"
            if (i + 3 < bytes.length && isRegular(bytes[i + 3]))
                continue;
            let j = i - 1;
            while (j >= 0 && isSpace(bytes[j]))
                j--;
            const genEnd = j + 1;
            while (j >= 0 && isDigit(bytes[j]))
                j--;
            const genStart = j + 1;
            if (genStart === genEnd)
                continue;
            while (j >= 0 && isSpace(bytes[j]))
                j--;
            const numEnd = j + 1;
            while (j >= 0 && isDigit(bytes[j]))
                j--;
            const numStart = j + 1;
            if (numStart === numEnd)
                continue;
            if (numStart > 0 && isRegular(bytes[numStart - 1]))
                continue;
            const num = Number(latin1(bytes, numStart, numEnd));
            const gen = Number(latin1(bytes, genStart, genEnd));
            if (!Number.isFinite(num) || !Number.isFinite(gen))
                continue;
            this.offsets.set(num, { offset: numStart, gen });
            i += 2;
        }
    }
    getObject(num, gen = 0) {
        const cached = this.cache.get(num);
        if (cached !== undefined)
            return cached;
        const slot = this.offsets.get(num);
        if (!slot) {
            const fromStream = this.compressed.get(num);
            return fromStream === undefined ? null : fromStream;
        }
        this.cache.set(num, null); // cycle guard while parsing
        let value = null;
        try {
            value = this.parseObjectAt(slot.offset, num, slot.gen);
        }
        catch (err) {
            this.warnings.push(`Object ${num} could not be read: ${err.message}`);
            value = null;
        }
        if (value === null) {
            const fromStream = this.compressed.get(num);
            if (fromStream !== undefined)
                value = fromStream;
        }
        this.cache.set(num, value);
        return value;
    }
    parseObjectAt(offset, expectedNum, gen) {
        const lexer = new Lexer(this.bytes, offset);
        const num = lexer.next();
        lexer.next(); // generation
        const keyword = lexer.next();
        if (!(keyword instanceof PdfOperator) || keyword.op !== 'obj')
            return null;
        if (typeof num === 'number' && num !== expectedNum)
            return null;
        const value = lexer.next();
        if (value === undefined)
            return null;
        lexer.skipWhitespace();
        const save = lexer.pos;
        const after = lexer.next();
        if (after instanceof PdfOperator && after.op === 'stream' && value instanceof Map) {
            const dict = value;
            let start = lexer.pos;
            if (this.bytes[start] === 0x0d)
                start++;
            if (this.bytes[start] === 0x0a)
                start++;
            let length = this.dictGet(dict, 'Length');
            let end = typeof length === 'number' ? start + length : -1;
            if (end < 0 || end > this.bytes.length || !this.looksLikeEndstream(end)) {
                end = this.findEndstream(start);
            }
            const raw = this.bytes.subarray(start, Math.max(start, end));
            return new PdfStreamObject(dict, raw);
        }
        lexer.pos = save;
        return this.decryptStrings(value, expectedNum, gen);
    }
    decryptStrings(value, num, gen) {
        if (!this.decryptor)
            return value;
        const walk = (node) => {
            if (node instanceof PdfString) {
                return new PdfString(this.decryptor.decrypt(node.bytes, num, gen));
            }
            if (Array.isArray(node))
                return node.map(walk);
            if (node instanceof Map) {
                const out = new Map();
                for (const [key, entry] of node)
                    out.set(key, walk(entry));
                return out;
            }
            return node;
        };
        return walk(value);
    }
    looksLikeEndstream(end) {
        for (let i = end; i < Math.min(end + 4, this.bytes.length); i++) {
            if (isSpace(this.bytes[i]))
                continue;
            return latin1(this.bytes, i, Math.min(i + 9, this.bytes.length)) === 'endstream';
        }
        return false;
    }
    findEndstream(start) {
        const target = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // endstream
        outer: for (let i = start; i + target.length <= this.bytes.length; i++) {
            for (let j = 0; j < target.length; j++) {
                if (this.bytes[i + j] !== target[j])
                    continue outer;
            }
            let end = i;
            if (end > start && this.bytes[end - 1] === 0x0a)
                end--;
            if (end > start && this.bytes[end - 1] === 0x0d)
                end--;
            return end;
        }
        return this.bytes.length;
    }
    /* -------------------------------------------------------------- trailer */
    readTrailer() {
        const merged = new Map();
        const keyword = [0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72]; // trailer
        outer: for (let i = 0; i + keyword.length <= this.bytes.length; i++) {
            for (let j = 0; j < keyword.length; j++) {
                if (this.bytes[i + j] !== keyword[j])
                    continue outer;
            }
            const lexer = new Lexer(this.bytes, i + keyword.length);
            const dict = lexer.next();
            if (dict instanceof Map) {
                for (const [key, value] of dict)
                    if (!merged.has(key))
                        merged.set(key, value);
            }
        }
        if (!merged.has('Root') || !merged.has('Encrypt')) {
            for (const num of this.offsets.keys()) {
                const value = this.getObject(num);
                const dict = value instanceof PdfStreamObject ? value.dict : value instanceof Map ? value : null;
                if (!dict)
                    continue;
                const type = dict.get('Type');
                if (type instanceof PdfName && type.name === 'XRef') {
                    for (const [key, entry] of dict)
                        if (!merged.has(key))
                            merged.set(key, entry);
                }
            }
        }
        this.trailer = merged;
    }
    setUpDecryption() {
        const encrypt = this.trailer.get('Encrypt');
        if (!encrypt)
            return;
        const dict = this.resolve(encrypt);
        if (!(dict instanceof Map))
            return;
        const ids = this.resolve(this.trailer.get('ID') ?? null);
        const firstId = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0].bytes : new Uint8Array(0);
        try {
            this.decryptor = Decryptor.create(dict, firstId, (o) => this.resolve(o));
            // Objects parsed before the handler existed hold undecrypted strings.
            this.cache.clear();
        }
        catch (err) {
            if (err instanceof DecryptionError)
                throw err;
            throw new DecryptionError(`This PDF is encrypted and could not be opened: ${err.message}`);
        }
    }
    expandObjectStreams() {
        if (this.objStmExpanded)
            return;
        this.objStmExpanded = true;
        for (const num of [...this.offsets.keys()]) {
            const value = this.getObject(num);
            if (!(value instanceof PdfStreamObject))
                continue;
            const type = this.dictGet(value.dict, 'Type');
            if (!(type instanceof PdfName) || type.name !== 'ObjStm')
                continue;
            try {
                this.readObjectStream(value, new PdfRef(num, this.offsets.get(num)?.gen ?? 0));
            }
            catch (err) {
                this.warnings.push(`Object stream ${num} could not be read: ${err.message}`);
            }
        }
    }
    readObjectStream(stream, owner) {
        const data = this.streamData(stream, owner);
        const count = this.dictGet(stream.dict, 'N');
        const first = this.dictGet(stream.dict, 'First');
        if (typeof count !== 'number' || typeof first !== 'number')
            return;
        const header = new Lexer(data, 0);
        const entries = [];
        for (let i = 0; i < count; i++) {
            const num = header.next();
            const offset = header.next();
            if (typeof num !== 'number' || typeof offset !== 'number')
                break;
            entries.push({ num, offset });
        }
        for (const entry of entries) {
            if (this.offsets.has(entry.num))
                continue;
            const lexer = new Lexer(data, first + entry.offset);
            const value = lexer.next();
            if (value !== undefined && !(value instanceof PdfOperator))
                this.compressed.set(entry.num, value);
        }
    }
    /* ---------------------------------------------------------------- pages */
    buildPages() {
        const root = this.resolve(this.trailer.get('Root') ?? null);
        const catalog = root instanceof Map ? root : this.findCatalog();
        const pagesRoot = catalog ? this.dictGet(catalog, 'Pages') : null;
        if (pagesRoot instanceof Map) {
            const visited = new Set();
            this.walkPageTree(pagesRoot, {}, visited);
        }
        if (this.pages.length === 0)
            this.collectLoosePages();
    }
    findCatalog() {
        for (const num of this.offsets.keys()) {
            const value = this.getObject(num);
            if (!(value instanceof Map))
                continue;
            const type = value.get('Type');
            if (type instanceof PdfName && type.name === 'Catalog')
                return value;
        }
        return null;
    }
    walkPageTree(node, inherited, visited) {
        if (visited.has(node) || this.pages.length > 5000)
            return;
        visited.add(node);
        const resourcesValue = this.dictGet(node, 'Resources');
        const mediaBoxValue = this.dictGet(node, 'MediaBox');
        const rotateValue = this.dictGet(node, 'Rotate');
        const context = {
            resources: resourcesValue instanceof Map ? resourcesValue : inherited.resources,
            mediaBox: Array.isArray(mediaBoxValue)
                ? mediaBoxValue.map((v) => (typeof this.resolve(v) === 'number' ? this.resolve(v) : 0))
                : inherited.mediaBox,
            rotate: typeof rotateValue === 'number' ? rotateValue : inherited.rotate,
        };
        const type = this.dictGet(node, 'Type');
        const kids = this.dictGet(node, 'Kids');
        if (Array.isArray(kids)) {
            for (const kid of kids) {
                const child = this.resolve(kid);
                if (child instanceof Map)
                    this.walkPageTree(child, context, visited);
            }
            return;
        }
        if (type instanceof PdfName && type.name === 'Pages')
            return;
        this.pushPage(node, context);
    }
    collectLoosePages() {
        const nums = [...this.offsets.keys()].sort((a, b) => a - b);
        for (const num of nums) {
            const value = this.getObject(num);
            if (!(value instanceof Map))
                continue;
            const dict = value;
            const type = dict.get('Type');
            if (type instanceof PdfName && type.name === 'Page') {
                const resources = this.dictGet(dict, 'Resources');
                this.pushPage(dict, {
                    resources: resources instanceof Map ? resources : undefined,
                });
            }
        }
    }
    pushPage(dict, context) {
        const box = context.mediaBox && context.mediaBox.length === 4 ? context.mediaBox : [0, 0, 612, 792];
        this.pages.push({
            dict,
            resources: context.resources ?? null,
            mediaBox: [box[0], box[1], box[2], box[3]],
            rotate: ((context.rotate ?? 0) % 360 + 360) % 360,
        });
    }
    /** Concatenated, decoded content streams for a page. */
    pageContent(page) {
        const contents = page.dict.get('Contents') ?? null;
        const parts = [];
        const add = (value, ref) => {
            const resolved = value instanceof PdfRef ? this.resolve(value) : value;
            const owner = value instanceof PdfRef ? value : ref;
            if (resolved instanceof PdfStreamObject) {
                parts.push(this.streamData(resolved, owner));
            }
            else if (Array.isArray(resolved)) {
                for (const item of resolved)
                    add(item);
            }
        };
        add(contents);
        if (parts.length === 0)
            return new Uint8Array(0);
        if (parts.length === 1)
            return parts[0];
        const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
            out[at++] = 0x0a;
        }
        return out;
    }
}
function isSpace(byte) {
    return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00 || byte === 0x0c;
}
function isDigit(byte) {
    return byte >= 0x30 && byte <= 0x39;
}
/** `D:20240115093000+02'00'` → `2024-01-15 09:30:00`. */
export function formatPdfDate(value) {
    const match = value.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (!match)
        return value;
    const [, year, month = '01', day = '01', hour, minute, second] = match;
    const date = `${year}-${month}-${day}`;
    if (hour === undefined)
        return date;
    return `${date} ${hour}:${minute ?? '00'}:${second ?? '00'}`;
}
//# sourceMappingURL=document.js.map