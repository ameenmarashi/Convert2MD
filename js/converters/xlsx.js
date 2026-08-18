/**
 * Excel (.xlsx / .xlsm) → Markdown.
 *
 * Each worksheet becomes a heading plus a table. Shared strings, inline
 * strings, cached formula results, hyperlinks and date-formatted numbers are
 * all resolved so the output reads like the spreadsheet, not like its XML.
 */
import { ZipArchive } from '../core/zip.js';
import { attr, child, children, descendants, parseXml, textOf } from '../core/xml.js';
import { collapseWhitespace, link as mdLink, MarkdownWriter, renderTable } from '../core/md.js';
import { ConversionError } from '../core/types.js';
import { normalizePart, readRelationships } from './docx.js';
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
export function convertXlsx(file, options) {
    const zip = ZipArchive.open(file.bytes);
    const workbookXml = zip.readText('xl/workbook.xml');
    if (!workbookXml)
        throw new ConversionError('Not a workbook: xl/workbook.xml is missing.');
    const warnings = [];
    const sharedStrings = readSharedStrings(zip);
    const dateStyles = readDateStyles(zip);
    const rels = readRelationships(zip, 'xl/_rels/workbook.xml.rels');
    const workbook = parseXml(workbookXml);
    const sheets = [];
    for (const sheet of descendants(workbook, 'sheet')) {
        const name = attr(sheet, 'name') ?? `Sheet${sheets.length + 1}`;
        const relId = attr(sheet, 'r:id');
        const rel = relId ? rels.get(relId) : undefined;
        const path = rel ? normalizePart('xl', rel.target) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
        sheets.push({ name, path, hidden: (attr(sheet, 'state') ?? '') !== '' });
    }
    const writer = new MarkdownWriter();
    const multiple = sheets.length > 1;
    for (const sheet of sheets) {
        const xml = zip.readText(sheet.path);
        if (!xml) {
            warnings.push(`Worksheet part missing: ${sheet.path}`);
            continue;
        }
        const rows = readSheet(parseXml(xml), sharedStrings, dateStyles, zip, sheet.path);
        if (multiple)
            writer.heading(2, sheet.name + (sheet.hidden ? ' (hidden)' : ''));
        if (rows.length === 0) {
            writer.paragraph('_Empty sheet._');
            continue;
        }
        writer.push(renderTable(rows));
    }
    if (writer.isEmpty)
        writer.paragraph('_The workbook contains no cell data._');
    return { markdown: writer.toString(), meta: readMeta(zip), warnings };
}
function readMeta(zip) {
    const meta = {};
    const core = zip.readText('docProps/core.xml');
    if (!core)
        return meta;
    const root = parseXml(core);
    for (const [key, tag] of [
        ['title', 'dc:title'],
        ['author', 'dc:creator'],
        ['modified', 'dcterms:modified'],
    ]) {
        const el = descendants(root, tag)[0];
        const value = el ? collapseWhitespace(textOf(el)).trim() : '';
        if (value)
            meta[key] = value;
    }
    return meta;
}
function readSharedStrings(zip) {
    const xml = zip.readText('xl/sharedStrings.xml');
    if (!xml)
        return [];
    const root = parseXml(xml);
    return descendants(root, 'si').map((si) => siText(si));
}
function siText(si) {
    const direct = child(si, 't');
    if (direct)
        return textOf(direct);
    return children(si, 'r')
        .map((run) => {
        const t = child(run, 't');
        return t ? textOf(t) : '';
    })
        .join('');
}
function readDateStyles(zip) {
    const styles = new Set();
    const xml = zip.readText('xl/styles.xml');
    if (!xml)
        return styles;
    const root = parseXml(xml);
    const customDateFormats = new Set();
    for (const numFmt of descendants(root, 'numFmt')) {
        const id = Number(attr(numFmt, 'numFmtId') ?? '');
        const code = (attr(numFmt, 'formatCode') ?? '').toLowerCase();
        const stripped = code.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, '');
        if (Number.isFinite(id) && /[ymdhs]/.test(stripped))
            customDateFormats.add(id);
    }
    const cellXfs = descendants(root, 'cellXfs')[0];
    if (!cellXfs)
        return styles;
    children(cellXfs, 'xf').forEach((xf, index) => {
        const id = Number(attr(xf, 'numFmtId') ?? '0');
        if (DATE_FORMAT_IDS.has(id) || customDateFormats.has(id))
            styles.add(index);
    });
    return styles;
}
function readSheet(sheetRoot, sharedStrings, dateStyles, zip, sheetPath) {
    const hyperlinks = readSheetHyperlinks(sheetRoot, zip, sheetPath);
    const grid = [];
    let maxColumn = 0;
    for (const row of descendants(sheetRoot, 'row')) {
        const rowIndexAttr = Number(attr(row, 'r') ?? '');
        const rowIndex = Number.isFinite(rowIndexAttr) && rowIndexAttr > 0 ? rowIndexAttr - 1 : grid.length;
        const cells = [];
        let cursor = 0;
        for (const cell of children(row, 'c')) {
            const ref = attr(cell, 'r') ?? '';
            const column = ref ? columnIndex(ref) : cursor;
            while (cells.length < column)
                cells.push('');
            cursor = column + 1;
            const value = cellValue(cell, sharedStrings, dateStyles);
            const href = hyperlinks.get(ref.toUpperCase());
            cells.push(href && value ? mdLink(value, href) : value);
        }
        while (grid.length < rowIndex)
            grid.push([]);
        grid[rowIndex] = cells;
        maxColumn = Math.max(maxColumn, cells.length);
    }
    // Drop fully empty leading/trailing rows and pad the grid to a rectangle.
    const trimmed = grid.map((row) => {
        const copy = row.slice();
        while (copy.length < maxColumn)
            copy.push('');
        return copy;
    });
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].every((c) => c.trim() === ''))
        trimmed.pop();
    while (trimmed.length > 0 && trimmed[0].every((c) => c.trim() === ''))
        trimmed.shift();
    // Drop trailing columns that are empty everywhere.
    let width = maxColumn;
    while (width > 0 && trimmed.every((row) => (row[width - 1] ?? '').trim() === ''))
        width--;
    return trimmed.map((row) => row.slice(0, width));
}
function readSheetHyperlinks(sheetRoot, zip, sheetPath) {
    const map = new Map();
    const links = descendants(sheetRoot, 'hyperlink');
    if (links.length === 0)
        return map;
    const dir = sheetPath.split('/').slice(0, -1).join('/');
    const name = sheetPath.split('/').pop() ?? '';
    const rels = readRelationships(zip, `${dir}/_rels/${name}.rels`);
    for (const link of links) {
        const ref = (attr(link, 'ref') ?? '').split(':')[0].toUpperCase();
        const relId = attr(link, 'r:id');
        const location = attr(link, 'location');
        if (relId) {
            const rel = rels.get(relId);
            if (rel)
                map.set(ref, rel.target);
        }
        else if (location) {
            map.set(ref, `#${location}`);
        }
    }
    return map;
}
function cellValue(cell, sharedStrings, dateStyles) {
    const type = attr(cell, 't') ?? 'n';
    if (type === 'inlineStr') {
        const is = child(cell, 'is');
        return is ? collapseWhitespace(siText(is)).trim() : '';
    }
    const v = child(cell, 'v');
    const raw = v ? textOf(v).trim() : '';
    if (!raw) {
        const t = child(cell, 't');
        return t ? collapseWhitespace(textOf(t)).trim() : '';
    }
    switch (type) {
        case 's': {
            const index = Number(raw);
            return Number.isFinite(index) ? collapseWhitespace(sharedStrings[index] ?? '').trim() : '';
        }
        case 'b':
            return raw === '1' ? 'TRUE' : 'FALSE';
        case 'e':
            return raw;
        case 'str':
            return collapseWhitespace(raw).trim();
        default: {
            const styleIndex = Number(attr(cell, 's') ?? '');
            const number = Number(raw);
            if (Number.isFinite(number) && Number.isFinite(styleIndex) && dateStyles.has(styleIndex)) {
                return excelSerialToIso(number);
            }
            return raw;
        }
    }
}
/** Excel day 0 is 1899-12-30 (the 1900 leap-year bug is baked into the epoch). */
export function excelSerialToIso(serial) {
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + Math.round(serial * 86400000);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime()))
        return String(serial);
    const iso = date.toISOString();
    const hasTime = Math.abs(serial % 1) > 1e-9;
    return hasTime ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}
export function columnIndex(ref) {
    let index = 0;
    for (const ch of ref.toUpperCase()) {
        const code = ch.charCodeAt(0);
        if (code < 65 || code > 90)
            break;
        index = index * 26 + (code - 64);
    }
    return Math.max(0, index - 1);
}
//# sourceMappingURL=xlsx.js.map