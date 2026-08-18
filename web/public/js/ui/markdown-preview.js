/**
 * Small Markdown renderer for the in-app preview.
 *
 * Builds real DOM nodes instead of assigning HTML strings, so converted
 * document content can never be injected as markup, and URLs are restricted to
 * a safe scheme list before they reach an attribute.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:|#|\.{0,2}\/|[^:]*$)/i;
const SAFE_IMAGE = /^(https?:|data:image\/(png|jpeg|gif|webp|bmp|svg\+xml|avif|x-icon|tiff);base64,|#|\.{0,2}\/|[^:]*$)/i;
export function renderMarkdown(markdown) {
    const fragment = document.createDocumentFragment();
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
            fragment.append(frontMatterBlock(lines.slice(1, end).join('\n')));
            index = end + 1;
        }
    }
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index++;
            continue;
        }
        const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            const marker = fence[1][0].repeat(3);
            const language = fence[2].trim();
            const body = [];
            index++;
            while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
                body.push(lines[index]);
                index++;
            }
            index++;
            fragment.append(codeBlockElement(body.join('\n'), language));
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const element = document.createElement(`h${heading[1].length}`);
            element.append(...inline(heading[2].replace(/\s+#+\s*$/, '')));
            fragment.append(element);
            index++;
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            fragment.append(document.createElement('hr'));
            index++;
            continue;
        }
        if (/^\s*>/.test(line)) {
            const body = [];
            while (index < lines.length && (/^\s*>/.test(lines[index]) || (body.length > 0 && lines[index].trim()))) {
                body.push(lines[index].replace(/^\s*>\s?/, ''));
                index++;
            }
            const quote = document.createElement('blockquote');
            quote.append(renderMarkdown(body.join('\n')));
            fragment.append(quote);
            continue;
        }
        if (isTableStart(lines, index)) {
            const rows = [];
            while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
                rows.push(lines[index]);
                index++;
            }
            fragment.append(tableElement(rows));
            continue;
        }
        if (listMarker(line)) {
            const block = [];
            while (index < lines.length && (lines[index].trim() || nextIsListContinuation(lines, index))) {
                if (!lines[index].trim() && !nextIsListContinuation(lines, index))
                    break;
                block.push(lines[index]);
                index++;
            }
            fragment.append(listElement(block));
            continue;
        }
        const paragraph = [];
        while (index < lines.length &&
            lines[index].trim() &&
            !/^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(lines[index]) &&
            !listMarker(lines[index]) &&
            !isTableStart(lines, index)) {
            paragraph.push(lines[index]);
            index++;
        }
        if (paragraph.length > 0) {
            const element = document.createElement('p');
            element.append(...inline(paragraph.join('\n')));
            fragment.append(element);
        }
        else {
            index++;
        }
    }
    return fragment;
}
function frontMatterBlock(yaml) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Front matter';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = yaml;
    pre.append(code);
    details.append(summary, pre);
    return details;
}
function codeBlockElement(body, language) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (language)
        code.className = `language-${language.replace(/[^\w-]/g, '')}`;
    code.textContent = body;
    pre.append(code);
    return pre;
}
function isTableStart(lines, index) {
    const header = lines[index];
    const divider = lines[index + 1];
    if (!header || !divider)
        return false;
    if (!header.includes('|'))
        return false;
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(divider) && divider.includes('-');
}
function tableElement(rows) {
    const table = document.createElement('table');
    const cells = rows.map(splitRow);
    const aligns = cells.length > 1 ? cells[1].map(alignmentOf) : [];
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [column, cell] of cells[0].entries()) {
        const th = document.createElement('th');
        applyAlignment(th, aligns[column]);
        th.append(...inline(cell));
        headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const row of cells.slice(2)) {
        const tr = document.createElement('tr');
        for (const [column, cell] of row.entries()) {
            const td = document.createElement('td');
            applyAlignment(td, aligns[column]);
            td.append(...inline(cell));
            tr.append(td);
        }
        tbody.append(tr);
    }
    table.append(tbody);
    return table;
}
function splitRow(row) {
    const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let current = '';
    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
            current += '|';
            i++;
            continue;
        }
        if (trimmed[i] === '|') {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += trimmed[i];
    }
    cells.push(current.trim());
    return cells;
}
function alignmentOf(cell) {
    const left = cell.trim().startsWith(':');
    const right = cell.trim().endsWith(':');
    if (left && right)
        return 'center';
    if (right)
        return 'right';
    if (left)
        return 'left';
    return '';
}
function applyAlignment(cell, align) {
    if (align)
        cell.style.textAlign = align;
}
function listMarker(line) {
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet)
        return { ordered: false, indent: bullet[1].length, content: bullet[2] };
    const ordered = line.match(/^(\s*)\d{1,9}[.)]\s+(.*)$/);
    if (ordered)
        return { ordered: true, indent: ordered[1].length, content: ordered[2] };
    return null;
}
function nextIsListContinuation(lines, index) {
    const next = lines[index + 1];
    return Boolean(next && (listMarker(next) || /^\s{2,}\S/.test(next)));
}
function listElement(block) {
    const items = [];
    for (const line of block) {
        const marker = listMarker(line);
        if (marker) {
            items.push({ ordered: marker.ordered, indent: marker.indent, text: marker.content, children: [] });
        }
        else if (items.length > 0) {
            items[items.length - 1].children.push(line.replace(/^\s{0,4}/, ''));
        }
    }
    return buildList(items, 0);
}
function buildList(items, depth) {
    const baseIndent = items.length > 0 ? Math.min(...items.map((i) => i.indent)) : 0;
    const list = document.createElement(items[0]?.ordered ? 'ol' : 'ul');
    let index = 0;
    while (index < items.length) {
        const item = items[index];
        const li = document.createElement('li');
        const checkbox = item.text.match(/^\[([ xX])]\s+(.*)$/);
        if (checkbox) {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.disabled = true;
            input.checked = checkbox[1].toLowerCase() === 'x';
            li.append(input, ' ');
            li.append(...inline(checkbox[2]));
        }
        else {
            li.append(...inline(item.text));
        }
        if (item.children.length > 0) {
            const nested = renderMarkdown(item.children.join('\n'));
            li.append(nested);
        }
        index++;
        const nestedItems = [];
        while (index < items.length && items[index].indent > baseIndent) {
            nestedItems.push(items[index]);
            index++;
        }
        if (nestedItems.length > 0 && depth < 6)
            li.append(buildList(nestedItems, depth + 1));
        list.append(li);
    }
    return list;
}
/* ------------------------------------------------------------------ inline */
const INLINE_PATTERN = /(!\[[^\]]*]\([^)\s]*(?:\s+"[^"]*")?\)|\[[^\]]*]\([^)\s]*(?:\s+"[^"]*")?\)|`+[^`]*`+|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|<sup>[^<]*<\/sup>|<sub>[^<]*<\/sub>|<br\s*\/?>|<https?:\/\/[^>\s]+>|https?:\/\/[^\s)<>]+)/;
export function inline(text) {
    const nodes = [];
    let rest = unescapeMarkdown(text, true);
    while (rest.length > 0) {
        const match = INLINE_PATTERN.exec(rest);
        if (!match || match.index === undefined) {
            nodes.push(document.createTextNode(unescapeMarkdown(rest, false)));
            break;
        }
        if (match.index > 0)
            nodes.push(document.createTextNode(unescapeMarkdown(rest.slice(0, match.index), false)));
        const token = match[0];
        nodes.push(inlineNode(token));
        rest = rest.slice(match.index + token.length);
    }
    return nodes;
}
function inlineNode(token) {
    if (token.startsWith('![')) {
        const parsed = parseLink(token.slice(1));
        const img = document.createElement('img');
        if (SAFE_IMAGE.test(parsed.href))
            img.src = parsed.href;
        img.alt = parsed.text;
        if (parsed.title)
            img.title = parsed.title;
        img.loading = 'lazy';
        return img;
    }
    if (token.startsWith('[')) {
        const parsed = parseLink(token);
        const anchor = document.createElement('a');
        if (SAFE_SCHEME.test(parsed.href))
            anchor.href = parsed.href;
        anchor.rel = 'noopener noreferrer';
        anchor.target = '_blank';
        if (parsed.title)
            anchor.title = parsed.title;
        anchor.append(...inline(parsed.text));
        return anchor;
    }
    if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.replace(/^`+/, '').replace(/`+$/, '').trim();
        return code;
    }
    if (token.startsWith('**') || token.startsWith('__')) {
        const strong = document.createElement('strong');
        strong.append(...inline(token.slice(2, -2)));
        return strong;
    }
    if (token.startsWith('~~')) {
        const del = document.createElement('del');
        del.append(...inline(token.slice(2, -2)));
        return del;
    }
    if (token.startsWith('<sup>') || token.startsWith('<sub>')) {
        const tag = token.slice(1, 4);
        const element = document.createElement(tag);
        element.textContent = token.slice(5, token.length - 6);
        return element;
    }
    if (/^<br\s*\/?>$/.test(token))
        return document.createElement('br');
    if (token.startsWith('<') && token.endsWith('>')) {
        const href = token.slice(1, -1);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.rel = 'noopener noreferrer';
        anchor.target = '_blank';
        anchor.textContent = href;
        return anchor;
    }
    if (token.startsWith('http')) {
        const anchor = document.createElement('a');
        anchor.href = token;
        anchor.rel = 'noopener noreferrer';
        anchor.target = '_blank';
        anchor.textContent = token;
        return anchor;
    }
    if (token.startsWith('*') || token.startsWith('_')) {
        const em = document.createElement('em');
        em.append(...inline(token.slice(1, -1)));
        return em;
    }
    return document.createTextNode(token);
}
function parseLink(token) {
    const close = findClosingBracket(token);
    const text = token.slice(1, close);
    const target = token.slice(close + 2, token.length - 1).trim();
    const titleMatch = target.match(/^(\S*)\s+"([^"]*)"$/);
    const href = (titleMatch ? titleMatch[1] : target).replace(/^<|>$/g, '');
    return { text, href, title: titleMatch ? titleMatch[2] : '' };
}
function findClosingBracket(token) {
    let depth = 0;
    for (let i = 0; i < token.length; i++) {
        if (token[i] === '[')
            depth++;
        else if (token[i] === ']') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return token.indexOf(']');
}
/** Markdown escapes are removed for display; `keepStructural` protects tokens. */
function unescapeMarkdown(text, keepStructural) {
    if (keepStructural)
        return text;
    return text.replace(/\\([\\`*_[\]<>|#+\-.!~()])/g, '$1');
}
//# sourceMappingURL=markdown-preview.js.map