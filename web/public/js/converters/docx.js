/**
 * Word (.docx) → Markdown.
 *
 * Reads the OOXML part graph directly: document body, numbering definitions,
 * style names (for heading detection), relationships (hyperlinks + images),
 * foot/endnotes, comments and core properties.
 */
import { ZipArchive } from '../core/zip.js';
import { attr, child, children, descendants, firstDescendant, parseXml, textOf } from '../core/xml.js';
import { collapseWhitespace, dataUri, escapeInline, imageMimeFor, image as mdImage, link as mdLink, MarkdownWriter, renderTable, } from '../core/md.js';
import { ConversionError } from '../core/types.js';
export function convertDocx(file, options) {
    const zip = ZipArchive.open(file.bytes);
    const documentXml = zip.readText('word/document.xml');
    if (!documentXml)
        throw new ConversionError('Not a Word document: word/document.xml is missing.');
    const ctx = new DocxContext(zip, options);
    const root = parseXml(documentXml);
    const body = firstDescendant(root, 'w:body');
    if (!body)
        throw new ConversionError('Word document has no body.');
    const writer = new MarkdownWriter();
    ctx.renderBlockContainer(body, writer, 0);
    ctx.appendNotes(writer);
    return {
        markdown: writer.toString(),
        meta: ctx.meta(),
        warnings: ctx.warnings,
        imageCount: ctx.imageCount,
    };
}
class DocxContext {
    constructor(zip, options) {
        this.zip = zip;
        this.options = options;
        this.warnings = [];
        this.imageCount = 0;
        this.styleNames = new Map();
        this.listLevels = new Map();
        this.counters = new Map();
        this.footnotes = new Map();
        this.endnotes = new Map();
        this.comments = new Map();
        this.usedFootnotes = [];
        this.footnotesXml = null;
        this.endnotesXml = null;
        this.rels = readRelationships(zip, 'word/_rels/document.xml.rels');
        this.readStyles();
        this.readNumbering();
        this.readNotes();
    }
    meta() {
        const meta = {};
        const core = this.zip.readText('docProps/core.xml');
        if (core) {
            const root = parseXml(core);
            const pick = (name) => {
                const el = firstDescendant(root, name);
                return el ? collapseWhitespace(textOf(el)).trim() : '';
            };
            assign(meta, 'title', pick('dc:title'));
            assign(meta, 'author', pick('dc:creator'));
            assign(meta, 'subject', pick('dc:subject'));
            assign(meta, 'keywords', pick('cp:keywords'));
            assign(meta, 'created', pick('dcterms:created'));
            assign(meta, 'modified', pick('dcterms:modified'));
        }
        const app = this.zip.readText('docProps/app.xml');
        if (app) {
            const root = parseXml(app);
            const company = firstDescendant(root, 'Company');
            if (company)
                assign(meta, 'company', textOf(company).trim());
        }
        return meta;
    }
    /* -------------------------------------------------------------- setup */
    readStyles() {
        const xml = this.zip.readText('word/styles.xml');
        if (!xml)
            return;
        for (const style of descendants(parseXml(xml), 'w:style')) {
            const id = attr(style, 'w:styleId');
            if (!id)
                continue;
            const nameEl = child(style, 'w:name');
            const name = nameEl ? attr(nameEl, 'w:val') ?? '' : '';
            this.styleNames.set(id, name || id);
        }
    }
    readNumbering() {
        const xml = this.zip.readText('word/numbering.xml');
        if (!xml)
            return;
        const root = parseXml(xml);
        const abstract = new Map();
        for (const abs of descendants(root, 'w:abstractNum')) {
            const id = attr(abs, 'w:abstractNumId');
            if (!id)
                continue;
            const levels = new Map();
            for (const lvl of children(abs, 'w:lvl')) {
                const ilvl = Number(attr(lvl, 'w:ilvl') ?? '0');
                const fmt = attr(child(lvl, 'w:numFmt') ?? lvl, 'w:val') ?? 'bullet';
                const startEl = child(lvl, 'w:start');
                const start = Number(startEl ? attr(startEl, 'w:val') ?? '1' : '1');
                levels.set(ilvl, {
                    ordered: fmt !== 'bullet' && fmt !== 'none',
                    start: Number.isFinite(start) ? start : 1,
                });
            }
            abstract.set(id, levels);
        }
        for (const num of descendants(root, 'w:num')) {
            const numId = attr(num, 'w:numId');
            const absRef = child(num, 'w:abstractNumId');
            const absId = absRef ? attr(absRef, 'w:val') : null;
            if (!numId || !absId)
                continue;
            const levels = abstract.get(absId);
            if (!levels)
                continue;
            for (const [ilvl, level] of levels)
                this.listLevels.set(`${numId}:${ilvl}`, level);
        }
    }
    readNotes() {
        const footnotes = this.zip.readText('word/footnotes.xml');
        if (footnotes)
            this.footnotesXml = parseXml(footnotes);
        const endnotes = this.zip.readText('word/endnotes.xml');
        if (endnotes)
            this.endnotesXml = parseXml(endnotes);
        const comments = this.zip.readText('word/comments.xml');
        if (comments) {
            for (const c of descendants(parseXml(comments), 'w:comment')) {
                const id = attr(c, 'w:id');
                if (id)
                    this.comments.set(id, this.plainText(c));
            }
        }
    }
    plainText(el) {
        return collapseWhitespace(descendants(el, 'w:p')
            .map((p) => descendants(p, 'w:t').map((t) => textOf(t)).join(''))
            .join(' ')).trim();
    }
    noteText(store, xml, tag, id) {
        const cached = store.get(id);
        if (cached !== undefined)
            return cached;
        if (!xml)
            return '';
        for (const note of descendants(xml, tag)) {
            if (attr(note, 'w:id') === id) {
                const text = this.plainText(note);
                store.set(id, text);
                return text;
            }
        }
        return '';
    }
    /* ------------------------------------------------------------ rendering */
    renderBlockContainer(container, writer, depth) {
        let listBuffer = [];
        const flushList = () => {
            if (listBuffer.length === 0)
                return;
            writer.push(listBuffer.join('\n'));
            listBuffer = [];
        };
        for (const node of container.children) {
            if (node.type !== 'element')
                continue;
            switch (node.local) {
                case 'p': {
                    const rendered = this.renderParagraph(node, depth);
                    if (rendered.listLine !== null) {
                        listBuffer.push(rendered.listLine);
                    }
                    else {
                        flushList();
                        this.counters.clear();
                        if (rendered.block)
                            writer.push(rendered.block);
                        if (rendered.pageBreak && this.options.pageSeparators)
                            writer.rule();
                    }
                    break;
                }
                case 'tbl':
                    flushList();
                    this.counters.clear();
                    writer.push(this.renderTableElement(node));
                    break;
                case 'sdt': {
                    const content = child(node, 'w:sdtContent');
                    if (content) {
                        flushList();
                        this.renderBlockContainer(content, writer, depth);
                    }
                    break;
                }
                case 'bookmarkStart':
                case 'bookmarkEnd':
                case 'sectPr':
                case 'proofErr':
                    break;
                default:
                    break;
            }
        }
        flushList();
    }
    renderParagraph(p, depth) {
        const pPr = child(p, 'w:pPr');
        const segments = this.collectSegments(p);
        const text = emitSegments(segments);
        const pageBreak = descendants(p, 'w:br').some((br) => attr(br, 'w:type') === 'page');
        if (!text.trim()) {
            const hasImage = segments.some((s) => s.text.startsWith('!['));
            if (!hasImage)
                return { block: '', listLine: null, pageBreak };
        }
        const numPr = pPr ? child(pPr, 'w:numPr') : null;
        if (numPr) {
            const line = this.renderListItem(numPr, text, depth);
            if (line !== null)
                return { block: '', listLine: line, pageBreak };
        }
        const heading = this.headingLevel(pPr);
        if (heading > 0) {
            return { block: `${'#'.repeat(heading)} ${text.replace(/\n+/g, ' ').trim()}`, listLine: null, pageBreak };
        }
        const styleId = this.styleId(pPr);
        const styleName = (styleId ? this.styleNames.get(styleId) ?? styleId : '').toLowerCase();
        if (styleName.includes('quote') || styleName === 'intensequote') {
            return {
                block: text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'),
                listLine: null,
                pageBreak,
            };
        }
        if (styleName.includes('code') || styleName === 'html preformatted') {
            return { block: '```\n' + stripInlineMarkup(text) + '\n```', listLine: null, pageBreak };
        }
        if (styleName === 'caption') {
            return { block: `*${text.trim()}*`, listLine: null, pageBreak };
        }
        return { block: text.trim(), listLine: null, pageBreak };
    }
    renderListItem(numPr, text, depth) {
        const numIdEl = child(numPr, 'w:numId');
        const ilvlEl = child(numPr, 'w:ilvl');
        const numId = numIdEl ? attr(numIdEl, 'w:val') ?? '' : '';
        const ilvl = Number(ilvlEl ? attr(ilvlEl, 'w:val') ?? '0' : '0') || 0;
        if (!numId || numId === '0')
            return null;
        const level = this.listLevels.get(`${numId}:${ilvl}`) ?? { ordered: false, start: 1 };
        const indent = '  '.repeat(ilvl + depth);
        let marker;
        if (level.ordered) {
            const key = `${numId}:${ilvl}`;
            const next = (this.counters.get(key) ?? level.start - 1) + 1;
            this.counters.set(key, next);
            for (const existing of [...this.counters.keys()]) {
                const existingLevel = Number(existing.split(':')[1]);
                if (existingLevel > ilvl)
                    this.counters.delete(existing);
            }
            marker = `${next}.`;
        }
        else {
            marker = this.options.bullet;
        }
        const body = text.trim().replace(/\n/g, `\n${indent}${' '.repeat(marker.length + 1)}`);
        return `${indent}${marker} ${body}`;
    }
    styleId(pPr) {
        if (!pPr)
            return null;
        const style = child(pPr, 'w:pStyle');
        return style ? attr(style, 'w:val') : null;
    }
    headingLevel(pPr) {
        if (!pPr)
            return 0;
        const styleId = this.styleId(pPr);
        if (styleId) {
            const name = (this.styleNames.get(styleId) ?? styleId).toLowerCase().replace(/\s+/g, '');
            const match = name.match(/^heading([1-9])$/);
            if (match)
                return Math.min(6, Number(match[1]));
            if (name === 'title')
                return 1;
            if (name === 'subtitle')
                return 2;
        }
        const outline = child(pPr, 'w:outlineLvl');
        if (outline) {
            const level = Number(attr(outline, 'w:val') ?? '');
            if (Number.isFinite(level) && level >= 0 && level <= 8)
                return Math.min(6, level + 1);
        }
        return 0;
    }
    collectSegments(container, inherited = {}) {
        const segments = [];
        let fieldInstruction = null;
        let fieldHref = null;
        const walk = (el, format) => {
            for (const node of el.children) {
                if (node.type !== 'element')
                    continue;
                switch (node.local) {
                    case 'r': {
                        const runFormat = { ...format, ...this.runFormat(node) };
                        for (const part of node.children) {
                            if (part.type !== 'element')
                                continue;
                            switch (part.local) {
                                case 't':
                                    segments.push(makeSegment(textOf(part), runFormat, fieldHref ?? format.href ?? null));
                                    break;
                                case 'tab':
                                    segments.push(makeSegment('\t', runFormat, null));
                                    break;
                                case 'br':
                                    if (attr(part, 'w:type') !== 'page')
                                        segments.push(makeSegment('\n', runFormat, null));
                                    break;
                                case 'cr':
                                    segments.push(makeSegment('\n', runFormat, null));
                                    break;
                                case 'noBreakHyphen':
                                    segments.push(makeSegment('-', runFormat, null));
                                    break;
                                case 'sym':
                                    segments.push(makeSegment(symbolChar(part), runFormat, null));
                                    break;
                                case 'drawing':
                                case 'pict':
                                case 'object': {
                                    const md = this.renderImage(part);
                                    if (md)
                                        segments.push(makeSegment(md, { ...runFormat, code: false }, null, true));
                                    break;
                                }
                                case 'footnoteReference': {
                                    const id = attr(part, 'w:id') ?? '';
                                    const text = this.noteText(this.footnotes, this.footnotesXml, 'w:footnote', id);
                                    if (text) {
                                        const marker = `fn${this.usedFootnotes.length + 1}`;
                                        this.usedFootnotes.push({ marker, text });
                                        segments.push(makeSegment(`[^${marker}]`, {}, null, true));
                                    }
                                    break;
                                }
                                case 'endnoteReference': {
                                    const id = attr(part, 'w:id') ?? '';
                                    const text = this.noteText(this.endnotes, this.endnotesXml, 'w:endnote', id);
                                    if (text) {
                                        const marker = `en${this.usedFootnotes.length + 1}`;
                                        this.usedFootnotes.push({ marker, text });
                                        segments.push(makeSegment(`[^${marker}]`, {}, null, true));
                                    }
                                    break;
                                }
                                case 'instrText':
                                    if (fieldInstruction !== null)
                                        fieldInstruction += textOf(part);
                                    break;
                                case 'fldChar': {
                                    const type = attr(part, 'w:fldCharType');
                                    if (type === 'begin') {
                                        fieldInstruction = '';
                                        fieldHref = null;
                                    }
                                    else if (type === 'separate') {
                                        fieldHref = parseHyperlinkField(fieldInstruction ?? '');
                                        fieldInstruction = null;
                                    }
                                    else if (type === 'end') {
                                        fieldHref = null;
                                        fieldInstruction = null;
                                    }
                                    break;
                                }
                                default:
                                    break;
                            }
                        }
                        break;
                    }
                    case 'hyperlink': {
                        const href = this.hyperlinkTarget(node);
                        walk(node, { ...format, href });
                        break;
                    }
                    case 'ins':
                    case 'smartTag':
                    case 'sdtContent':
                    case 'bdo':
                    case 'dir':
                        walk(node, format);
                        break;
                    case 'sdt': {
                        const content = child(node, 'w:sdtContent');
                        if (content)
                            walk(content, format);
                        break;
                    }
                    case 'fldSimple': {
                        const href = parseHyperlinkField(attr(node, 'w:instr') ?? '');
                        walk(node, href ? { ...format, href } : format);
                        break;
                    }
                    case 'commentRangeEnd':
                        break;
                    case 'commentReference': {
                        if (!this.options.includeNotes)
                            break;
                        const id = attr(node, 'w:id') ?? '';
                        const text = this.comments.get(id);
                        if (text)
                            segments.push(makeSegment(` <!-- comment: ${text} --> `, {}, null, true));
                        break;
                    }
                    case 'del':
                    case 'delText':
                        break;
                    default:
                        break;
                }
            }
        };
        walk(container, inherited);
        return segments;
    }
    runFormat(run) {
        const rPr = child(run, 'w:rPr');
        if (!rPr)
            return {};
        const on = (name) => {
            const el = child(rPr, name);
            if (!el)
                return false;
            const val = attr(el, 'w:val');
            return val === null || val === '1' || val === 'true' || val === 'on';
        };
        const vertAlign = child(rPr, 'w:vertAlign');
        const align = vertAlign ? attr(vertAlign, 'w:val') : null;
        const styleEl = child(rPr, 'w:rStyle');
        const styleId = styleEl ? attr(styleEl, 'w:val') ?? '' : '';
        const styleName = (this.styleNames.get(styleId) ?? styleId).toLowerCase();
        const fonts = child(rPr, 'w:rFonts');
        const ascii = fonts ? (attr(fonts, 'w:ascii') ?? '').toLowerCase() : '';
        return {
            bold: on('w:b') || on('w:bCs'),
            italic: on('w:i') || on('w:iCs'),
            strike: on('w:strike') || on('w:dstrike'),
            sup: align === 'superscript',
            sub: align === 'subscript',
            code: styleName.includes('code') || ascii.includes('consolas') || ascii.includes('courier') || ascii.includes('mono'),
        };
    }
    hyperlinkTarget(el) {
        const id = attr(el, 'r:id');
        if (id) {
            const rel = this.rels.get(id);
            if (rel)
                return rel.target;
        }
        const anchor = attr(el, 'w:anchor');
        return anchor ? `#${anchor}` : null;
    }
    renderImage(el) {
        if (this.options.imageMode === 'skip')
            return '';
        const blip = firstDescendant(el, 'a:blip') ?? firstDescendant(el, 'v:imagedata');
        const id = blip ? attr(blip, 'r:embed') ?? attr(blip, 'r:id') : null;
        const docPr = firstDescendant(el, 'wp:docPr');
        const alt = docPr ? (attr(docPr, 'descr') || attr(docPr, 'name') || '').trim() : '';
        if (!id)
            return '';
        const rel = this.rels.get(id);
        if (!rel)
            return '';
        const path = rel.external ? rel.target : normalizePart('word', rel.target);
        if (rel.external) {
            this.imageCount++;
            return mdImage(alt || 'image', rel.target);
        }
        if (this.options.imageMode === 'reference') {
            this.imageCount++;
            return mdImage(alt || basename(path), path.replace(/^word\//, ''));
        }
        const bytes = this.zip.read(path);
        if (!bytes) {
            this.warnings.push(`Image part not found: ${path}`);
            return '';
        }
        if (bytes.length > this.options.maxEmbeddedImageBytes) {
            this.warnings.push(`Skipped embedding ${basename(path)} (${formatBytes(bytes.length)} exceeds the inline image limit).`);
            return mdImage(alt || basename(path), basename(path));
        }
        this.imageCount++;
        return mdImage(alt || basename(path), dataUri(bytes, imageMimeFor(path)));
    }
    renderTableElement(tbl) {
        const rows = [];
        let headerRows = 0;
        for (const tr of children(tbl, 'w:tr')) {
            const cells = [];
            const trPr = child(tr, 'w:trPr');
            const isHeader = trPr !== null && child(trPr, 'w:tblHeader') !== null;
            for (const tc of children(tr, 'w:tc')) {
                const parts = [];
                for (const node of tc.children) {
                    if (node.type !== 'element')
                        continue;
                    if (node.local === 'p') {
                        const segs = this.collectSegments(node);
                        const text = emitSegments(segs).trim();
                        if (text)
                            parts.push(text);
                    }
                    else if (node.local === 'tbl') {
                        parts.push(collapseWhitespace(this.plainText(node)));
                    }
                }
                const tcPr = child(tc, 'w:tcPr');
                const span = tcPr ? Number(attr(child(tcPr, 'w:gridSpan') ?? tc, 'w:val') ?? '1') || 1 : 1;
                cells.push(parts.join('<br>'));
                for (let i = 1; i < span; i++)
                    cells.push('');
            }
            if (cells.length === 0)
                continue;
            if (isHeader && rows.length === headerRows)
                headerRows++;
            rows.push(cells);
        }
        if (rows.length === 0)
            return '';
        if (headerRows === 0 && rows.length > 1 && rows[0].every((c) => c.trim().length > 0))
            headerRows = 1;
        if (headerRows === 0)
            rows.unshift(new Array(rows[0].length).fill(''));
        return renderTable(rows);
    }
    appendNotes(writer) {
        if (this.usedFootnotes.length === 0)
            return;
        writer.rule();
        writer.push(this.usedFootnotes.map((n) => `[^${n.marker}]: ${n.text}`).join('\n'));
    }
}
/* ------------------------------------------------------------------ utils */
function makeSegment(text, format, href, literal = false) {
    return {
        text: literal ? text : escapeInline(text),
        bold: format.bold ?? false,
        italic: format.italic ?? false,
        strike: format.strike ?? false,
        code: format.code ?? false,
        sup: format.sup ?? false,
        sub: format.sub ?? false,
        href: href ?? format.href ?? null,
    };
}
function sameFormat(a, b) {
    return (a.bold === b.bold &&
        a.italic === b.italic &&
        a.strike === b.strike &&
        a.code === b.code &&
        a.sup === b.sup &&
        a.sub === b.sub &&
        a.href === b.href);
}
/** Merge like-formatted runs first so Word's run splitting does not leak `****`. */
export function emitSegments(segments) {
    const merged = [];
    for (const seg of segments) {
        if (!seg.text)
            continue;
        const last = merged[merged.length - 1];
        if (last && sameFormat(last, seg)) {
            last.text += seg.text;
        }
        else {
            merged.push({ ...seg });
        }
    }
    let out = '';
    for (const seg of merged) {
        let text = seg.text.replace(/\t/g, '    ');
        if (!text.trim()) {
            out += text;
            continue;
        }
        const leading = text.match(/^\s*/)?.[0] ?? '';
        const trailing = text.match(/\s*$/)?.[0] ?? '';
        let core = text.slice(leading.length, text.length - trailing.length);
        if (seg.code)
            core = `\`${core.replace(/`/g, '')}\``;
        if (seg.strike)
            core = `~~${core}~~`;
        if (seg.bold)
            core = `**${core}**`;
        if (seg.italic)
            core = `*${core}*`;
        if (seg.sup)
            core = `<sup>${core}</sup>`;
        if (seg.sub)
            core = `<sub>${core}</sub>`;
        if (seg.href)
            core = mdLink(core, seg.href);
        out += `${leading}${core}${trailing}`;
    }
    return out.replace(/[ \t]+\n/g, '\n');
}
function stripInlineMarkup(text) {
    return text.replace(/\\([\\`*_[\]<>|])/g, '$1').replace(/(\*\*|__|~~|`)/g, '');
}
function parseHyperlinkField(instruction) {
    const match = instruction.match(/HYPERLINK\s+"([^"]+)"/i) ?? instruction.match(/HYPERLINK\s+(\S+)/i);
    return match ? match[1] : null;
}
function symbolChar(sym) {
    const code = attr(sym, 'w:char');
    if (!code)
        return '';
    const value = parseInt(code, 16);
    if (!Number.isFinite(value))
        return '';
    // Symbol/Wingdings live in the private use area; map the common bullets.
    const mapped = { 0xf0b7: '•', 0xf0a7: '▪', 0xf0d8: '➢', 0xf0fc: '✔' };
    return mapped[value] ?? String.fromCodePoint(value & 0xff ? value : 0x2022);
}
export function readRelationships(zip, path) {
    const map = new Map();
    const xml = zip.readText(path);
    if (!xml)
        return map;
    for (const rel of descendants(parseXml(xml), 'Relationship')) {
        const id = attr(rel, 'Id');
        const target = attr(rel, 'Target');
        if (!id || !target)
            continue;
        map.set(id, {
            target,
            type: attr(rel, 'Type') ?? '',
            external: (attr(rel, 'TargetMode') ?? '') === 'External',
        });
    }
    return map;
}
export function normalizePart(baseDir, target) {
    if (target.startsWith('/'))
        return target.slice(1);
    const segments = `${baseDir}/${target}`.split('/');
    const out = [];
    for (const segment of segments) {
        if (segment === '.' || segment === '')
            continue;
        if (segment === '..')
            out.pop();
        else
            out.push(segment);
    }
    return out.join('/');
}
export function basename(path) {
    return path.split('/').pop() ?? path;
}
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function assign(target, key, value) {
    if (value)
        target[key] = value;
}
//# sourceMappingURL=docx.js.map