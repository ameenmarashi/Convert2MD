/** Markdown emission helpers shared by every converter. */
const INLINE_ESCAPE = /([\\`*_[\]<>|])/g;
const LINE_LEADING = /^(\s*)([-+*>#]|\d+[.)])(\s)/;
/** Escape characters that would otherwise be parsed as Markdown syntax. */
export function escapeInline(text) {
    return text.replace(INLINE_ESCAPE, '\\$1');
}
/** Escape a whole line, including markers that only bite at line start. */
export function escapeBlock(text) {
    return escapeInline(text).replace(LINE_LEADING, (_m, indent, marker, tail) => {
        return `${indent}\\${marker}${tail}`;
    });
}
export function escapeTableCell(text) {
    // `escapeInline` already escapes the pipe; only line breaks need folding.
    return escapeInline(text).replace(/\r?\n/g, '<br>');
}
export function collapseWhitespace(text) {
    return text.replace(/[\t\f\v\u00a0]+/g, ' ').replace(/ {2,}/g, ' ');
}
export function link(text, href, title) {
    const safeHref = encodeHref(href);
    const label = text.trim() || safeHref;
    const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
    return `[${label}](${safeHref}${suffix})`;
}
export function image(alt, href, title) {
    const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
    return `![${alt.replace(/[[\]]/g, '')}](${encodeHref(href)}${suffix})`;
}
function encodeHref(href) {
    const trimmed = href.trim();
    if (trimmed.startsWith('data:'))
        return trimmed;
    if (/[ ()<>]/.test(trimmed))
        return `<${trimmed.replace(/>/g, '%3E')}>`;
    return trimmed;
}
export function renderTable(rows, options = {}) {
    if (rows.length === 0)
        return '';
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const padded = rows.map((row) => {
        const copy = row.slice();
        while (copy.length < width)
            copy.push('');
        return copy.map((cell) => escapeTableCell(cell).trim());
    });
    const widths = new Array(width).fill(3);
    for (const row of padded) {
        for (let c = 0; c < width; c++)
            widths[c] = Math.max(widths[c], [...row[c]].length);
    }
    const line = (cells) => `| ${cells.map((cell, c) => cell.padEnd(widths[c])).join(' | ')} |`;
    const [header, ...body] = padded;
    const divider = widths.map((w, c) => {
        const align = options.align?.[c] ?? null;
        if (align === 'c')
            return `:${'-'.repeat(Math.max(w - 2, 1))}:`;
        if (align === 'r')
            return `${'-'.repeat(Math.max(w - 1, 2))}:`;
        if (align === 'l')
            return `:${'-'.repeat(Math.max(w - 1, 2))}`;
        return '-'.repeat(w);
    });
    return [line(header), `| ${divider.join(' | ')} |`, ...body.map(line)].join('\n');
}
const FENCE_LANGS = {
    js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', yml: 'yaml',
    md: 'markdown', kt: 'kotlin', rs: 'rust', cs: 'csharp', cpp: 'cpp', h: 'c', m: 'objectivec',
};
export function fenceLanguage(extension) {
    const ext = extension.replace(/^\./, '').toLowerCase();
    return FENCE_LANGS[ext] ?? ext;
}
export function codeBlock(code, language = '') {
    const longest = [...code.matchAll(/`{3,}/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${code.replace(/\n+$/, '')}\n${fence}`;
}
export function yamlFrontMatter(meta) {
    const entries = Object.entries(meta).filter(([, value]) => value !== undefined && value !== '');
    if (entries.length === 0)
        return '';
    const lines = entries.map(([key, value]) => `${key}: ${yamlScalar(value)}`);
    return ['---', ...lines, '---'].join('\n');
}
function yamlScalar(value) {
    const needsQuotes = /^[\s>|@`&*!%#{[\]}]|[:#]\s|["'\\]|^$|^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
        /^-?\d+(\.\d+)?$/.test(value) || value.includes('\n');
    if (!needsQuotes)
        return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
/**
 * Final tidy-up: normalise newlines, drop trailing spaces that are not an
 * intentional hard break, and collapse runs of blank lines.
 */
export function normalizeMarkdown(markdown) {
    return markdown
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, (match) => (match === '  ' ? '  ' : ''))
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\s+$/, '')
        .concat('\n');
}
/** Assembles blocks with exactly one blank line between them. */
export class MarkdownWriter {
    constructor() {
        this.blocks = [];
    }
    push(block) {
        const trimmed = block.replace(/\s+$/, '');
        if (trimmed.trim().length === 0)
            return;
        this.blocks.push(trimmed);
    }
    heading(level, text) {
        const clean = collapseWhitespace(text).trim();
        if (!clean)
            return;
        this.push(`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${clean}`);
    }
    paragraph(text) {
        this.push(text.trim());
    }
    code(text, language = '') {
        if (!text.trim())
            return;
        this.push(codeBlock(text, language));
    }
    quote(text) {
        const body = text.trim();
        if (!body)
            return;
        this.push(body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    }
    rule() {
        this.blocks.push('---');
    }
    table(rows, options) {
        this.push(renderTable(rows, options));
    }
    get isEmpty() {
        return this.blocks.length === 0;
    }
    toString() {
        return normalizeMarkdown(this.blocks.join('\n\n'));
    }
}
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 without relying on `btoa`, which is byte-string only and slow here. */
export function toBase64(bytes) {
    let out = '';
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < len ? bytes[i + 1] : 0;
        const b2 = i + 2 < len ? bytes[i + 2] : 0;
        out += BASE64_CHARS[b0 >> 2];
        out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < len ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < len ? BASE64_CHARS[b2 & 63] : '=';
    }
    return out;
}
const IMAGE_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
    svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf',
    wmf: 'image/wmf', heic: 'image/heic', avif: 'image/avif', ico: 'image/x-icon',
};
export function imageMimeFor(name) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_MIME[ext] ?? 'application/octet-stream';
}
export function dataUri(bytes, mime) {
    return `data:${mime};base64,${toBase64(bytes)}`;
}
export function countWords(markdown) {
    const text = markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/[#>*_`|-]/g, ' ');
    const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return matches ? matches.length : 0;
}
//# sourceMappingURL=md.js.map