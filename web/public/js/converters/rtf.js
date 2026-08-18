/**
 * Rich Text Format (.rtf) → Markdown.
 *
 * A single pass over the control-word stream with a group stack: character
 * formatting nests with the groups, non-content destinations (font tables,
 * stylesheets, pictures, `\*` extensions) are skipped whole, and paragraph
 * properties drive headings, lists and tables.
 */
import { escapeInline, link as mdLink, MarkdownWriter, renderTable } from '../core/md.js';
const SKIP_DESTINATIONS = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'info', 'pict', 'object',
    'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'xmlnstbl',
    'mmathPr', 'wgrffmtfilter', 'nonesttables', 'shppict', 'header', 'headerl', 'headerr', 'headerf',
    'footer', 'footerl', 'footerr', 'footerf', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'panose',
    'falt', 'listtext', 'pntext', 'pntxta', 'pntxtb', 'atrfstart', 'atrfend', 'annotation',
]);
const CONTROL_SYMBOLS = {
    par: '\n',
    line: '\n',
    tab: '\t',
    emdash: '—',
    endash: '–',
    emspace: ' ',
    enspace: ' ',
    qmspace: ' ',
    bullet: '•',
    lquote: '‘',
    rquote: '’',
    ldblquote: '“',
    rdblquote: '”',
    '~': ' ',
    '_': '-',
    '-': '',
};
const CP1252_HIGH = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
    0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
    0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
    0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
export function convertRtf(file, options) {
    const source = latin1Decode(file.bytes);
    const parser = new RtfParser(source, options);
    return parser.parse();
}
class RtfParser {
    constructor(src, options) {
        this.src = src;
        this.options = options;
        this.pos = 0;
        this.stack = [];
        this.state = {
            bold: false,
            italic: false,
            strike: false,
            hidden: false,
            fontSize: 0,
            destination: '',
            unicodeSkip: 1,
        };
        this.paragraphs = [];
        this.current = newParagraph();
        this.pendingCells = [];
        this.tableRows = [];
        this.meta = {};
        this.warnings = [];
        this.linkTarget = null;
        this.fieldInstruction = null;
        this.skipCharacters = 0;
    }
    parse() {
        if (!this.src.startsWith('{\\rtf'))
            this.warnings.push('File does not start with an RTF header; parsed anyway.');
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === '{') {
                this.pos++;
                this.stack.push({ ...this.state });
                continue;
            }
            if (ch === '}') {
                this.pos++;
                const restored = this.stack.pop();
                if (restored) {
                    if (this.state.destination === 'fldrslt' && restored.destination !== 'fldrslt')
                        this.linkTarget = null;
                    this.state = restored;
                }
                continue;
            }
            if (ch === '\\') {
                this.readControl();
                continue;
            }
            if (ch === '\r' || ch === '\n') {
                this.pos++;
                continue;
            }
            this.pos++;
            this.pushText(ch);
        }
        this.endParagraph();
        return this.render();
    }
    readControl() {
        this.pos++; // backslash
        const ch = this.src[this.pos];
        if (ch === undefined)
            return;
        if (ch === "'") {
            const hex = this.src.slice(this.pos + 1, this.pos + 3);
            this.pos += 3;
            const code = parseInt(hex, 16);
            if (Number.isFinite(code)) {
                if (this.skipCharacters > 0)
                    this.skipCharacters--;
                else
                    this.pushText(CP1252_HIGH[code] ?? String.fromCharCode(code));
            }
            return;
        }
        if (!/[a-zA-Z]/.test(ch)) {
            this.pos++;
            if (ch === '\\' || ch === '{' || ch === '}') {
                this.pushText(ch);
            }
            else if (ch === '*') {
                this.markIgnorableDestination();
            }
            else if (ch === '\n' || ch === '\r') {
                this.endParagraphBreak();
            }
            else {
                const mapped = CONTROL_SYMBOLS[ch];
                if (mapped !== undefined)
                    this.pushText(mapped);
            }
            return;
        }
        const start = this.pos;
        while (this.pos < this.src.length && /[a-zA-Z]/.test(this.src[this.pos]))
            this.pos++;
        const word = this.src.slice(start, this.pos);
        let parameter = null;
        if (this.src[this.pos] === '-' || /\d/.test(this.src[this.pos] ?? '')) {
            const numStart = this.pos;
            if (this.src[this.pos] === '-')
                this.pos++;
            while (this.pos < this.src.length && /\d/.test(this.src[this.pos]))
                this.pos++;
            parameter = Number(this.src.slice(numStart, this.pos));
        }
        if (this.src[this.pos] === ' ')
            this.pos++;
        this.applyControlWord(word, parameter);
    }
    markIgnorableDestination() {
        // `\*\destination` — skip the whole group unless it is one we understand.
        const save = this.pos;
        if (this.src[this.pos] !== '\\')
            return;
        this.pos++;
        const start = this.pos;
        while (this.pos < this.src.length && /[a-zA-Z]/.test(this.src[this.pos]))
            this.pos++;
        const word = this.src.slice(start, this.pos);
        if (this.src[this.pos] === ' ')
            this.pos++;
        if (word === 'fldinst') {
            this.state.destination = 'fldinst';
            this.fieldInstruction = '';
            return;
        }
        this.pos = save;
        this.skipGroup();
    }
    skipGroup() {
        let depth = 1;
        while (this.pos < this.src.length && depth > 0) {
            const ch = this.src[this.pos];
            if (ch === '\\') {
                this.pos += 2;
                continue;
            }
            if (ch === '{')
                depth++;
            else if (ch === '}')
                depth--;
            this.pos++;
        }
        const restored = this.stack.pop();
        if (restored)
            this.state = restored;
    }
    applyControlWord(word, parameter) {
        if (SKIP_DESTINATIONS.has(word)) {
            if (word === 'listtext' || word === 'pntext') {
                this.current.isListItem = true;
            }
            this.skipGroup();
            return;
        }
        switch (word) {
            case 'par':
                this.endParagraphBreak();
                return;
            case 'line':
            case 'softline':
                this.pushText('\n');
                return;
            case 'tab':
                this.pushText('\t');
                return;
            case 'cell':
                this.pendingCells.push(this.currentText().trim());
                this.current = newParagraph();
                return;
            case 'row':
            case 'nestrow':
                if (this.pendingCells.length > 0) {
                    this.tableRows.push(this.pendingCells);
                    this.pendingCells = [];
                }
                this.current = newParagraph();
                return;
            case 'trowd':
            case 'intbl':
                this.current.inTable = true;
                return;
            case 'pard':
                this.current.outlineLevel = 0;
                this.current.listLevel = 0;
                this.current.isListItem = false;
                this.current.quoted = false;
                this.state.bold = false;
                this.state.italic = false;
                this.state.strike = false;
                return;
            case 'plain':
                this.state.bold = false;
                this.state.italic = false;
                this.state.strike = false;
                this.state.hidden = false;
                return;
            case 'b':
                this.state.bold = parameter !== 0;
                return;
            case 'i':
                this.state.italic = parameter !== 0;
                return;
            case 'strike':
            case 'striked':
                this.state.strike = parameter !== 0;
                return;
            case 'v':
                this.state.hidden = parameter !== 0;
                return;
            case 'fs':
                this.state.fontSize = (parameter ?? 24) / 2;
                this.current.maxFontSize = Math.max(this.current.maxFontSize, this.state.fontSize);
                return;
            case 'outlinelvl':
                this.current.outlineLevel = (parameter ?? 0) + 1;
                return;
            case 'ilvl':
                this.current.listLevel = parameter ?? 0;
                return;
            case 'li':
                this.current.listLevel = Math.max(this.current.listLevel, Math.floor((parameter ?? 0) / 360));
                return;
            case 'ls':
                this.current.isListItem = true;
                return;
            case 'uc':
                this.state.unicodeSkip = parameter ?? 1;
                return;
            case 'u': {
                const code = parameter ?? 0;
                const value = code < 0 ? code + 65536 : code;
                this.pushText(safeChar(value));
                this.skipCharacters = this.state.unicodeSkip;
                return;
            }
            case 'field':
                this.linkTarget = null;
                return;
            case 'fldrslt':
                this.state.destination = 'fldrslt';
                return;
            case 'title':
            case 'author':
            case 'subject':
            case 'company':
            case 'operator':
                this.readMetaGroup(word);
                return;
            case 'ansi':
            case 'mac':
            case 'pc':
            case 'pca':
            case 'deff':
            case 'nouicompat':
            case 'viewkind':
            case 'lang':
            case 'langfe':
            case 'f':
            case 'cf':
            case 'cb':
            case 'highlight':
            case 'sa':
            case 'sb':
            case 'sl':
            case 'slmult':
            case 'qc':
            case 'qj':
            case 'ql':
            case 'qr':
            case 'fi':
            case 'ri':
            case 'widctlpar':
            case 'hyphpar':
            case 'sectd':
            case 'pgwsxn':
            case 'pghsxn':
                return;
            default:
                if (CONTROL_SYMBOLS[word] !== undefined)
                    this.pushText(CONTROL_SYMBOLS[word]);
                return;
        }
    }
    readMetaGroup(key) {
        const start = this.pos;
        let depth = 1;
        let text = '';
        while (this.pos < this.src.length && depth > 0) {
            const ch = this.src[this.pos];
            if (ch === '{')
                depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0)
                    break;
            }
            else if (ch === '\\') {
                this.pos += 2;
                continue;
            }
            else {
                text += ch;
            }
            this.pos++;
        }
        const value = text.trim();
        if (value)
            this.meta[key] = value;
        if (this.pos <= start)
            this.pos = start;
    }
    pushText(text) {
        if (!text)
            return;
        if (this.state.hidden)
            return;
        if (this.skipCharacters > 0 && text !== '\n' && text !== '\t') {
            this.skipCharacters--;
            return;
        }
        if (this.state.destination === 'fldinst') {
            this.fieldInstruction = (this.fieldInstruction ?? '') + text;
            const match = this.fieldInstruction.match(/HYPERLINK\s+"([^"]+)"/i);
            if (match)
                this.linkTarget = match[1];
            return;
        }
        // Track the largest size actually used for text, not just where \fs appears,
        // so paragraphs that inherit a size still take part in heading detection.
        this.current.maxFontSize = Math.max(this.current.maxFontSize, this.state.fontSize || 12);
        const runs = this.current.runs;
        const last = runs[runs.length - 1];
        if (last &&
            last.bold === this.state.bold &&
            last.italic === this.state.italic &&
            last.strike === this.state.strike &&
            last.href === this.linkTarget) {
            last.text += text;
            return;
        }
        runs.push({
            text,
            bold: this.state.bold,
            italic: this.state.italic,
            strike: this.state.strike,
            href: this.linkTarget,
        });
    }
    currentText() {
        return this.current.runs.map((r) => r.text).join('');
    }
    endParagraphBreak() {
        this.endParagraph();
        this.current = newParagraph();
    }
    endParagraph() {
        if (this.current.runs.length === 0)
            return;
        if (this.current.inTable) {
            this.current = newParagraph();
            return;
        }
        this.paragraphs.push(this.current);
        this.current = newParagraph();
    }
    render() {
        const writer = new MarkdownWriter();
        const bodySize = medianFontSize(this.paragraphs);
        let listBuffer = [];
        const flushList = () => {
            if (listBuffer.length === 0)
                return;
            writer.push(listBuffer.join('\n'));
            listBuffer = [];
        };
        for (const paragraph of this.paragraphs) {
            const text = renderRuns(paragraph.runs).replace(/[ \t]+/g, ' ').trim();
            if (!text)
                continue;
            if (paragraph.isListItem && paragraph.outlineLevel === 0) {
                const indent = '  '.repeat(Math.min(paragraph.listLevel, 4));
                listBuffer.push(`${indent}${this.options.bullet} ${text}`);
                continue;
            }
            flushList();
            if (paragraph.outlineLevel > 0) {
                writer.heading(Math.min(6, paragraph.outlineLevel), stripWrappingEmphasis(text));
                continue;
            }
            if (paragraph.maxFontSize > 0 && bodySize > 0 && paragraph.maxFontSize >= bodySize * 1.25 && text.length < 120) {
                const ratio = paragraph.maxFontSize / bodySize;
                writer.heading(ratio >= 1.7 ? 1 : ratio >= 1.45 ? 2 : 3, stripWrappingEmphasis(text));
                continue;
            }
            writer.push(text);
        }
        flushList();
        if (this.tableRows.length > 0) {
            const width = this.tableRows.reduce((max, row) => Math.max(max, row.length), 0);
            const rows = this.tableRows.map((row) => {
                const copy = row.slice();
                while (copy.length < width)
                    copy.push('');
                return copy;
            });
            writer.push(renderTable(rows));
        }
        if (writer.isEmpty)
            writer.paragraph('_The document contains no text._');
        return { markdown: writer.toString(), meta: this.meta, warnings: this.warnings };
    }
}
function newParagraph() {
    return {
        runs: [],
        outlineLevel: 0,
        listLevel: 0,
        isListItem: false,
        inTable: false,
        maxFontSize: 0,
        quoted: false,
    };
}
function renderRuns(runs) {
    let out = '';
    for (const run of runs) {
        const raw = run.text.replace(/\n/g, '  \n');
        if (!raw.trim()) {
            out += raw;
            continue;
        }
        const leading = raw.match(/^\s*/)?.[0] ?? '';
        const trailing = raw.match(/\s*$/)?.[0] ?? '';
        let core = escapeInline(raw.trim());
        if (run.strike)
            core = `~~${core}~~`;
        if (run.bold)
            core = `**${core}**`;
        if (run.italic)
            core = `*${core}*`;
        if (run.href)
            core = mdLink(core, run.href);
        out += `${leading}${core}${trailing}`;
    }
    return out;
}
/** Headings carry their weight in the `#` markers; `# **Title**` is noise. */
function stripWrappingEmphasis(text) {
    const bold = text.match(/^\*\*(.+)\*\*$/s);
    if (bold && !bold[1].includes('**'))
        return bold[1];
    const italic = text.match(/^\*(.+)\*$/s);
    if (italic && !italic[1].includes('*'))
        return italic[1];
    return text;
}
function medianFontSize(paragraphs) {
    const sizes = paragraphs
        .filter((p) => p.maxFontSize > 0 && p.runs.some((r) => r.text.trim()))
        .map((p) => p.maxFontSize)
        .sort((a, b) => a - b);
    if (sizes.length === 0)
        return 0;
    return sizes[Math.floor(sizes.length / 2)];
}
function safeChar(code) {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff)
        return '';
    try {
        return String.fromCodePoint(code);
    }
    catch {
        return '';
    }
}
function latin1Decode(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return out;
}
//# sourceMappingURL=rtf.js.map