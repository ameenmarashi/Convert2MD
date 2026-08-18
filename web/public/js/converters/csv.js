/** CSV / TSV → Markdown table, with delimiter sniffing and RFC 4180 quoting. */
import { decodeText } from '../core/decode.js';
import { MarkdownWriter, renderTable } from '../core/md.js';
const MAX_ROWS = 5000;
export function convertCsv(file, _options) {
    const { text, encoding } = decodeText(file.bytes);
    const extension = (file.name.split('.').pop() ?? '').toLowerCase();
    const delimiter = extension === 'tsv' ? '\t' : sniffDelimiter(text);
    const warnings = [];
    let rows = parseDelimited(text, delimiter);
    rows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
    if (rows.length === 0) {
        return { markdown: '_The file contains no rows._\n', meta: { encoding }, warnings };
    }
    if (rows.length > MAX_ROWS) {
        warnings.push(`Only the first ${MAX_ROWS} rows were converted (the file has ${rows.length}).`);
        rows = rows.slice(0, MAX_ROWS);
    }
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const normalised = rows.map((row) => {
        const copy = row.slice();
        while (copy.length < width)
            copy.push('');
        return copy;
    });
    const writer = new MarkdownWriter();
    writer.push(renderTable(normalised, { align: inferAlignment(normalised) }));
    return {
        markdown: writer.toString(),
        meta: {
            encoding,
            rows: String(normalised.length - 1),
            columns: String(width),
            delimiter: delimiter === '\t' ? 'tab' : delimiter,
        },
        warnings,
    };
}
export function sniffDelimiter(text) {
    const sample = text.slice(0, 8192).split(/\r?\n/).slice(0, 20);
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestScore = -1;
    for (const candidate of candidates) {
        const counts = sample.map((line) => countOutsideQuotes(line, candidate));
        const nonZero = counts.filter((c) => c > 0);
        if (nonZero.length === 0)
            continue;
        const average = nonZero.reduce((sum, c) => sum + c, 0) / nonZero.length;
        const variance = nonZero.reduce((sum, c) => sum + (c - average) ** 2, 0) / nonZero.length;
        const score = average * nonZero.length - variance * 2;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}
function countOutsideQuotes(line, delimiter) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"')
                i++;
            else
                inQuotes = !inQuotes;
        }
        else if (!inQuotes && ch === delimiter) {
            count++;
        }
    }
    return count;
}
export function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const source = text.replace(/^﻿/, '');
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (inQuotes) {
            if (ch === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                field += ch;
            }
            continue;
        }
        if (ch === '"' && field.trim() === '') {
            inQuotes = true;
            field = '';
            continue;
        }
        if (ch === delimiter) {
            row.push(field);
            field = '';
            continue;
        }
        if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && source[i + 1] === '\n')
                i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            continue;
        }
        field += ch;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
/** Right-align columns whose data cells are all numeric. */
function inferAlignment(rows) {
    if (rows.length < 2)
        return [];
    const width = rows[0].length;
    const align = [];
    for (let c = 0; c < width; c++) {
        let numeric = 0;
        let filled = 0;
        for (let r = 1; r < rows.length; r++) {
            const cell = (rows[r][c] ?? '').trim();
            if (!cell)
                continue;
            filled++;
            if (/^[-+]?[\d.,]+%?$/.test(cell) && /\d/.test(cell))
                numeric++;
        }
        align.push(filled > 0 && numeric === filled ? 'r' : null);
    }
    return align;
}
//# sourceMappingURL=csv.js.map