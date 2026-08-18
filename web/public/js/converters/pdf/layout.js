/**
 * Turns positioned text runs into Markdown.
 *
 * PDF carries no structure, so structure is inferred: runs are grouped into
 * lines, lines into paragraphs by their vertical rhythm, font size ranking
 * drives heading levels, leading bullets/numbers become lists, and text that
 * repeats at the same spot on most pages is treated as a running header or
 * footer and dropped.
 */
import { escapeBlock, escapeInline } from '../../core/md.js';
export function buildLines(items) {
    if (items.length === 0)
        return [];
    const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 0.6 ? b.y - a.y : a.x - b.x));
    const lines = [];
    let current = [];
    let currentY = sorted[0].y;
    let currentSize = sorted[0].size;
    const flush = () => {
        if (current.length === 0)
            return;
        const line = mergeLine(current);
        if (line.text.trim())
            lines.push(line);
        current = [];
    };
    for (const item of sorted) {
        const tolerance = Math.max(1.2, Math.min(currentSize, item.size) * 0.45);
        if (current.length > 0 && Math.abs(item.y - currentY) > tolerance) {
            flush();
            currentY = item.y;
            currentSize = item.size;
        }
        current.push(item);
        currentY = current.reduce((sum, it) => sum + it.y, 0) / current.length;
        currentSize = Math.max(currentSize, item.size);
    }
    flush();
    return lines.sort((a, b) => b.y - a.y);
}
function mergeLine(items) {
    const ordered = [...items].sort((a, b) => a.x - b.x);
    let text = '';
    let endX = ordered[0].x;
    let bold = true;
    let italic = true;
    let size = 0;
    let weight = 0;
    for (const item of ordered) {
        const gap = item.x - endX;
        const reference = Math.max(item.size, size || item.size);
        if (text && gap > reference * 0.22 && !text.endsWith(' ') && !item.text.startsWith(' '))
            text += ' ';
        text += item.text;
        endX = Math.max(endX, item.x + item.width);
        const length = Math.max(1, item.text.trim().length);
        size += item.size * length;
        weight += length;
        if (!item.bold)
            bold = false;
        if (!item.italic)
            italic = false;
    }
    return {
        y: ordered.reduce((sum, it) => sum + it.y, 0) / ordered.length,
        x: ordered[0].x,
        endX,
        size: weight > 0 ? size / weight : ordered[0].size,
        bold,
        italic,
        text: text.replace(/\s+/g, ' ').trim(),
    };
}
/** Text that appears at the same height on most pages is chrome, not content. */
export function stripRunningHeadersAndFooters(pages) {
    if (pages.length < 3)
        return;
    const counts = new Map();
    const candidates = pages.map((lines) => {
        const edge = [...lines.slice(0, 2), ...lines.slice(-2)];
        return new Set(edge.map(fingerprint));
    });
    for (const set of candidates) {
        for (const key of set)
            counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
    const repeated = new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
    if (repeated.size === 0)
        return;
    pages.forEach((lines, index) => {
        const keep = lines.filter((line, position) => {
            const isEdge = position < 2 || position >= lines.length - 2;
            return !(isEdge && repeated.has(fingerprint(line)));
        });
        pages[index] = keep;
    });
}
function fingerprint(line) {
    return `${Math.round(line.y / 6)}|${line.text.replace(/\d+/g, '#').toLowerCase().slice(0, 60)}`;
}
const BULLET_PATTERN = /^([•·▪◦‣∙○●■□*–—-])\s+(.*)$/;
const ORDERED_PATTERN = /^(\d{1,3})[.)]\s+(.*)$/;
const LETTER_PATTERN = /^([a-zA-Z])[.)]\s+(.*)$/;
export function pageToMarkdown(lines, options, bodySize, sizeLevels) {
    if (lines.length === 0)
        return '';
    const gaps = [];
    for (let i = 1; i < lines.length; i++)
        gaps.push(lines[i - 1].y - lines[i].y);
    const medianGap = median(gaps.filter((g) => g > 0)) || bodySize * 1.2;
    const leftEdge = Math.min(...lines.map((l) => l.x));
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const previous = i > 0 ? lines[i - 1] : null;
        const gap = previous ? previous.y - line.y : Number.POSITIVE_INFINITY;
        const listMatch = matchListItem(line.text);
        const headingLevel = options.detectHeadings ? headingLevelFor(line, bodySize, sizeLevels) : 0;
        const startsBlock = !previous ||
            gap > medianGap * 1.45 ||
            Math.abs(line.size - previous.size) > Math.max(0.8, bodySize * 0.12) ||
            listMatch !== null ||
            headingLevel > 0 ||
            blocks[blocks.length - 1]?.kind !== 'paragraph';
        if (headingLevel > 0) {
            blocks.push({ kind: 'heading', level: headingLevel, size: line.size, lines: [line] });
            continue;
        }
        if (listMatch) {
            blocks.push({
                kind: 'list',
                level: 0,
                size: line.size,
                lines: [{ ...line, text: listMatch.text }],
                ordered: listMatch.ordered,
                marker: listMatch.marker,
                indent: Math.max(0, Math.round((line.x - leftEdge) / 18)),
            });
            continue;
        }
        const last = blocks[blocks.length - 1];
        if (!startsBlock && last && last.kind === 'paragraph') {
            last.lines.push(line);
        }
        else if (last && last.kind === 'list' && !startsBlock) {
            last.lines.push(line);
        }
        else {
            blocks.push({ kind: 'paragraph', level: 0, size: line.size, lines: [line] });
        }
    }
    // Consecutive list items belong to one Markdown list; a blank line between
    // them would split it into separate lists in most renderers.
    let out = '';
    let previousKind = null;
    for (const block of blocks) {
        const text = renderBlock(block, options);
        if (!text.trim())
            continue;
        if (out)
            out += previousKind === 'list' && block.kind === 'list' ? '\n' : '\n\n';
        out += text;
        previousKind = block.kind;
    }
    return out;
}
function renderBlock(block, options) {
    const text = joinLines(block.lines);
    if (!text.trim())
        return '';
    if (block.kind === 'heading') {
        return `${'#'.repeat(Math.min(6, Math.max(1, block.level)))} ${escapeInline(text).replace(/\s+/g, ' ')}`;
    }
    if (block.kind === 'list') {
        const indent = '  '.repeat(Math.min(block.indent ?? 0, 4));
        const marker = block.ordered ? `${block.marker}.` : options.bullet;
        return `${indent}${marker} ${escapeInline(text)}`;
    }
    const body = escapeBlock(text);
    return block.lines.every((l) => l.bold) && block.lines.length === 1 && text.length < 120
        ? `**${body}**`
        : body;
}
function joinLines(lines) {
    let out = '';
    for (const line of lines) {
        if (!out) {
            out = line.text;
            continue;
        }
        if (/[­-]$/.test(out) && /^[a-zà-ÿ]/.test(line.text)) {
            out = `${out.slice(0, -1)}${line.text}`;
        }
        else {
            out = `${out} ${line.text}`;
        }
    }
    return out.replace(/\s+/g, ' ').trim();
}
function matchListItem(text) {
    const bullet = text.match(BULLET_PATTERN);
    if (bullet && bullet[2].trim())
        return { ordered: false, marker: bullet[1], text: bullet[2].trim() };
    const ordered = text.match(ORDERED_PATTERN);
    if (ordered && ordered[2].trim() && ordered[2].trim().length > 1) {
        return { ordered: true, marker: ordered[1], text: ordered[2].trim() };
    }
    const letter = text.match(LETTER_PATTERN);
    if (letter && letter[2].trim().length > 2 && /^[a-z]$/.test(letter[1])) {
        return { ordered: false, marker: letter[1], text: `${letter[1]}) ${letter[2].trim()}` };
    }
    return null;
}
function headingLevelFor(line, bodySize, sizeLevels) {
    const text = line.text.trim();
    if (!text || text.length > 160)
        return 0;
    const index = sizeLevels.findIndex((size) => Math.abs(size - line.size) < 0.6);
    if (index >= 0 && line.size > bodySize * 1.08)
        return Math.min(6, index + 1);
    if (line.bold && line.size >= bodySize * 0.98 && text.length < 90 && !/[.;,]$/.test(text)) {
        return Math.min(6, sizeLevels.length + 1);
    }
    return 0;
}
export function bodyFontSize(pages) {
    const weights = new Map();
    for (const lines of pages) {
        for (const line of lines) {
            const key = Math.round(line.size * 2) / 2;
            weights.set(key, (weights.get(key) ?? 0) + line.text.length);
        }
    }
    let best = 12;
    let bestWeight = -1;
    for (const [size, weight] of weights) {
        if (weight > bestWeight) {
            best = size;
            bestWeight = weight;
        }
    }
    return best;
}
/** Distinct heading sizes above the body size, largest first, capped at six. */
export function headingSizeLevels(pages, bodySize) {
    const sizes = new Map();
    for (const lines of pages) {
        for (const line of lines) {
            const key = Math.round(line.size * 2) / 2;
            if (key > bodySize * 1.08 && line.text.trim().length > 0) {
                sizes.set(key, (sizes.get(key) ?? 0) + 1);
            }
        }
    }
    return [...sizes.keys()].sort((a, b) => b - a).slice(0, 6);
}
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
//# sourceMappingURL=layout.js.map