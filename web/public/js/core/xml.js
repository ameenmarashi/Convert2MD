/**
 * Tolerant XML/HTML parser.
 *
 * `DOMParser` is not exposed to Web Workers, and all conversion here runs off
 * the main thread so a 300-page PDF never freezes the UI. This parser therefore
 * has to stand in for the DOM: it is namespace-aware enough for OOXML/ODF,
 * forgiving enough for real-world HTML (unclosed <p>, bare attributes, stray
 * `<`), and shares its shape with the Dart port so both apps behave alike.
 */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
    'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
const CLOSES_P = new Set([
    'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
    trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
    rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
    deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
    frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ',
    para: '¶', sect: '§', dagger: '†', Dagger: '‡', permil: '‰',
    euro: '€', pound: '£', yen: '¥', cent: '¢', laquo: '«',
    raquo: '»', larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑',
    ne: '≠', le: '≤', ge: '≥', infin: '∞', alpha: 'α', beta: 'β',
    gamma: 'γ', delta: 'δ', pi: 'π', mu: 'μ', omega: 'ω', shy: '',
    ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍',
};
export function decodeEntities(input) {
    if (!input.includes('&'))
        return input;
    return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
                try {
                    return String.fromCodePoint(code);
                }
                catch {
                    return match;
                }
            }
            return match;
        }
        const named = NAMED_ENTITIES[body];
        return named !== undefined ? named : match;
    });
}
function makeElement(name, attrs, html) {
    const colon = name.indexOf(':');
    const local = colon >= 0 ? name.slice(colon + 1) : name;
    return {
        type: 'element',
        name: html ? name.toLowerCase() : name,
        local: html ? local.toLowerCase() : local,
        attrs,
        children: [],
        parent: null,
    };
}
function appendText(parent, value) {
    if (!value)
        return;
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') {
        last.value += value;
        return;
    }
    parent.children.push({ type: 'text', value, parent });
}
function parse(src, options) {
    const root = makeElement(options.html ? '#document' : '#document', {}, options.html);
    const stack = [root];
    let i = 0;
    const len = src.length;
    const top = () => stack[stack.length - 1];
    const closeTag = (name) => {
        for (let s = stack.length - 1; s > 0; s--) {
            if (stack[s].name === name || stack[s].local === name) {
                stack.length = s;
                return;
            }
        }
        // Unmatched close tag: ignore, matching browser behaviour.
    };
    while (i < len) {
        const lt = src.indexOf('<', i);
        if (lt === -1) {
            appendText(top(), decodeEntities(src.slice(i)));
            break;
        }
        if (lt > i)
            appendText(top(), decodeEntities(src.slice(i, lt)));
        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            i = end === -1 ? len : end + 3;
            continue;
        }
        if (src.startsWith('<![CDATA[', lt)) {
            const end = src.indexOf(']]>', lt + 9);
            const text = src.slice(lt + 9, end === -1 ? len : end);
            appendText(top(), text);
            i = end === -1 ? len : end + 3;
            continue;
        }
        if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
            const end = src.indexOf('>', lt + 2);
            i = end === -1 ? len : end + 1;
            continue;
        }
        if (src.startsWith('</', lt)) {
            const end = src.indexOf('>', lt + 2);
            if (end === -1) {
                i = len;
                continue;
            }
            let name = src.slice(lt + 2, end).trim();
            if (options.html)
                name = name.toLowerCase();
            closeTag(name);
            i = end + 1;
            continue;
        }
        const tag = readTag(src, lt, options.html);
        if (!tag) {
            // A stray "<" that does not start a tag is literal text.
            appendText(top(), '<');
            i = lt + 1;
            continue;
        }
        const element = makeElement(tag.name, tag.attrs, options.html);
        if (options.html)
            applyImplicitClose(stack, element.local);
        const parent = top();
        element.parent = parent;
        parent.children.push(element);
        const isVoid = tag.selfClosing || (options.html && VOID_ELEMENTS.has(element.local));
        if (!isVoid) {
            if (options.html && RAW_TEXT_ELEMENTS.has(element.local)) {
                const closeIdx = findRawTextEnd(src, tag.end, element.local);
                appendText(element, src.slice(tag.end, closeIdx.textEnd));
                i = closeIdx.next;
                continue;
            }
            stack.push(element);
        }
        i = tag.end;
    }
    return root;
}
function applyImplicitClose(stack, tag) {
    const current = stack[stack.length - 1];
    if (stack.length <= 1)
        return;
    const closeCurrent = () => {
        stack.pop();
    };
    if (current.local === 'p' && CLOSES_P.has(tag))
        return closeCurrent();
    if (current.local === 'li' && tag === 'li')
        return closeCurrent();
    if ((current.local === 'dt' || current.local === 'dd') && (tag === 'dt' || tag === 'dd')) {
        return closeCurrent();
    }
    if ((current.local === 'td' || current.local === 'th') && ['td', 'th', 'tr'].includes(tag)) {
        closeCurrent();
        if (tag === 'tr' && stack[stack.length - 1]?.local === 'tr')
            stack.pop();
        return;
    }
    if (current.local === 'tr' && tag === 'tr')
        return closeCurrent();
    if (current.local === 'option' && (tag === 'option' || tag === 'optgroup'))
        return closeCurrent();
    if (['thead', 'tbody', 'tfoot'].includes(current.local) && ['thead', 'tbody', 'tfoot'].includes(tag)) {
        return closeCurrent();
    }
    if (current.local === 'head' && tag === 'body')
        return closeCurrent();
}
function findRawTextEnd(src, from, tag) {
    const lower = src.toLowerCase();
    const close = lower.indexOf(`</${tag}`, from);
    if (close === -1)
        return { textEnd: src.length, next: src.length };
    const gt = src.indexOf('>', close);
    return { textEnd: close, next: gt === -1 ? src.length : gt + 1 };
}
function isNameStart(ch) {
    return /[A-Za-z_]/.test(ch);
}
function readTag(src, start, html) {
    let i = start + 1;
    if (i >= src.length || !isNameStart(src[i]))
        return null;
    const nameStart = i;
    while (i < src.length && /[^\s/>]/.test(src[i]))
        i++;
    const name = src.slice(nameStart, i);
    const attrs = {};
    let selfClosing = false;
    while (i < src.length) {
        while (i < src.length && /\s/.test(src[i]))
            i++;
        if (i >= src.length)
            break;
        if (src[i] === '/') {
            selfClosing = true;
            i++;
            continue;
        }
        if (src[i] === '>') {
            i++;
            break;
        }
        const attrStart = i;
        while (i < src.length && !/[\s=/>]/.test(src[i]))
            i++;
        let attrName = src.slice(attrStart, i);
        if (!attrName) {
            i++;
            continue;
        }
        if (html)
            attrName = attrName.toLowerCase();
        while (i < src.length && /\s/.test(src[i]))
            i++;
        let value = '';
        if (src[i] === '=') {
            i++;
            while (i < src.length && /\s/.test(src[i]))
                i++;
            const quote = src[i];
            if (quote === '"' || quote === "'") {
                const end = src.indexOf(quote, i + 1);
                value = src.slice(i + 1, end === -1 ? src.length : end);
                i = end === -1 ? src.length : end + 1;
            }
            else {
                const valStart = i;
                while (i < src.length && !/[\s>]/.test(src[i]))
                    i++;
                value = src.slice(valStart, i);
            }
        }
        else {
            value = attrName;
        }
        attrs[attrName] = decodeEntities(value);
    }
    return { name, attrs, selfClosing, end: i };
}
export function parseXml(src) {
    return parse(stripXmlProlog(src), { html: false });
}
export function parseHtml(src) {
    return parse(src, { html: true });
}
function stripXmlProlog(src) {
    return src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
}
/* ---------------------------------------------------------------- queries */
function matches(el, query) {
    return query.includes(':') ? el.name === query : el.local === query;
}
export function children(el, query) {
    const out = [];
    for (const node of el.children) {
        if (node.type === 'element' && (!query || matches(node, query)))
            out.push(node);
    }
    return out;
}
export function child(el, query) {
    for (const node of el.children) {
        if (node.type === 'element' && matches(node, query))
            return node;
    }
    return null;
}
/** Depth-first descendants matching `query`, document order. */
export function descendants(el, query) {
    const out = [];
    const walk = (node) => {
        for (const kid of node.children) {
            if (kid.type !== 'element')
                continue;
            if (matches(kid, query))
                out.push(kid);
            walk(kid);
        }
    };
    walk(el);
    return out;
}
export function firstDescendant(el, query) {
    for (const kid of el.children) {
        if (kid.type !== 'element')
            continue;
        if (matches(kid, query))
            return kid;
        const found = firstDescendant(kid, query);
        if (found)
            return found;
    }
    return null;
}
/** Attribute lookup that ignores namespace prefixes when the query has none. */
export function attr(el, query) {
    const direct = el.attrs[query];
    if (direct !== undefined)
        return direct;
    if (query.includes(':'))
        return null;
    for (const [key, value] of Object.entries(el.attrs)) {
        const colon = key.indexOf(':');
        if (colon >= 0 && key.slice(colon + 1) === query)
            return value;
    }
    return null;
}
export function textOf(node) {
    if (node.type === 'text')
        return node.value;
    let out = '';
    for (const kid of node.children)
        out += textOf(kid);
    return out;
}
export function elementPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.name !== '#document') {
        parts.unshift(cur.name);
        cur = cur.parent;
    }
    return parts.join('/');
}
//# sourceMappingURL=xml.js.map