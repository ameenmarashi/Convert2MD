/**
 * Email (.eml / .mht / .mhtml) → Markdown.
 *
 * Headers become a summary table, the best body part (HTML preferred, plain
 * text as fallback) becomes the content, and attachments are listed by name.
 */
import { decodeText } from '../core/decode.js';
import { escapeBlock, MarkdownWriter, renderTable } from '../core/md.js';
import { parseHtml } from '../core/xml.js';
import { htmlToMarkdown } from './html.js';
import { plainTextToMarkdown } from './text.js';
export function convertEml(file, options) {
    const warnings = [];
    const root = parsePart(file.bytes);
    const writer = new MarkdownWriter();
    const meta = {};
    const subject = decodeHeaderValue(root.headers.get('subject') ?? '');
    const from = decodeHeaderValue(root.headers.get('from') ?? '');
    const to = decodeHeaderValue(root.headers.get('to') ?? '');
    const cc = decodeHeaderValue(root.headers.get('cc') ?? '');
    const date = decodeHeaderValue(root.headers.get('date') ?? '');
    const { html, plain, attachments } = collectParts(root);
    let body = '';
    if (html) {
        body = htmlToMarkdown(parseHtml(html), {
            bullet: options.bullet,
            resolveUrl: (url, kind) => (kind === 'image' && url.startsWith('cid:') ? null : url),
        });
    }
    else if (plain) {
        body = plainTextToMarkdown(plain, options);
    }
    else {
        warnings.push('No readable body part was found in this message.');
    }
    if (subject) {
        meta.title = subject;
        // Newsletters usually repeat the subject as the body's first heading.
        const firstHeading = body.match(/^#{1,3}\s+(.+)$/m);
        const duplicated = firstHeading !== null && normalizeHeading(firstHeading[1]) === normalizeHeading(subject);
        if (!duplicated)
            writer.heading(1, subject);
    }
    if (from)
        meta.author = from;
    if (date)
        meta.date = date;
    const summary = [['Field', 'Value']];
    if (from)
        summary.push(['From', from]);
    if (to)
        summary.push(['To', to]);
    if (cc)
        summary.push(['Cc', cc]);
    if (date)
        summary.push(['Date', date]);
    if (summary.length > 1)
        writer.push(renderTable(summary));
    if (body.trim())
        writer.push(body);
    if (attachments.length > 0) {
        writer.heading(2, 'Attachments');
        writer.push(attachments.map((name) => `- ${escapeBlock(name)}`).join('\n'));
    }
    return { markdown: writer.toString(), meta, warnings };
}
function normalizeHeading(text) {
    return text.replace(/[*_`\\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function collectParts(part) {
    let html = '';
    let plain = '';
    const attachments = [];
    const walk = (node) => {
        if (node.parts.length > 0) {
            for (const child of node.parts)
                walk(child);
            return;
        }
        const isAttachment = node.disposition === 'attachment' || (node.filename && !node.contentType.startsWith('text/'));
        if (isAttachment) {
            if (node.filename)
                attachments.push(node.filename);
            return;
        }
        const text = decodeText(node.body, node.charset).text;
        if (node.contentType.startsWith('text/html')) {
            if (!html)
                html = text;
        }
        else if (node.contentType.startsWith('text/') || !node.contentType) {
            if (!plain)
                plain = text;
        }
    };
    walk(part);
    return { html, plain, attachments };
}
function parsePart(bytes) {
    const split = splitHeaders(bytes);
    const headers = parseHeaders(split.headerText);
    const contentTypeRaw = headers.get('content-type') ?? 'text/plain';
    const contentType = contentTypeRaw.split(';')[0].trim().toLowerCase();
    const charset = parameterOf(contentTypeRaw, 'charset') || 'utf-8';
    const boundary = parameterOf(contentTypeRaw, 'boundary');
    const dispositionRaw = headers.get('content-disposition') ?? '';
    const disposition = dispositionRaw.split(';')[0].trim().toLowerCase();
    const filename = decodeHeaderValue(parameterOf(dispositionRaw, 'filename') || parameterOf(contentTypeRaw, 'name'));
    const encoding = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
    let body = split.body;
    const part = {
        headers,
        body: new Uint8Array(0),
        contentType,
        charset,
        disposition,
        filename,
        parts: [],
    };
    if (contentType.startsWith('multipart/') && boundary) {
        part.parts = splitMultipart(body, boundary).map(parsePart);
        return part;
    }
    if (encoding === 'base64')
        body = decodeBase64(body);
    else if (encoding === 'quoted-printable')
        body = decodeQuotedPrintable(body);
    part.body = body;
    return part;
}
function splitHeaders(bytes) {
    for (let i = 0; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
            return { headerText: latin1(bytes.subarray(0, i)), body: bytes.subarray(i + 2) };
        }
        if (bytes[i] === 0x0d &&
            bytes[i + 1] === 0x0a &&
            bytes[i + 2] === 0x0d &&
            bytes[i + 3] === 0x0a) {
            return { headerText: latin1(bytes.subarray(0, i)), body: bytes.subarray(i + 4) };
        }
    }
    return { headerText: latin1(bytes), body: new Uint8Array(0) };
}
function parseHeaders(text) {
    const headers = new Map();
    const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (!headers.has(key))
            headers.set(key, value);
    }
    return headers;
}
function parameterOf(header, name) {
    const match = header.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
    if (!match)
        return '';
    return (match[2] ?? match[1] ?? '').trim();
}
function splitMultipart(body, boundary) {
    const text = latin1(body);
    const marker = `--${boundary}`;
    const parts = [];
    let index = text.indexOf(marker);
    if (index === -1)
        return parts;
    while (index !== -1) {
        const start = text.indexOf('\n', index);
        if (start === -1)
            break;
        const nextIndex = text.indexOf(marker, start);
        const end = nextIndex === -1 ? text.length : nextIndex;
        let sliceEnd = end;
        if (text[sliceEnd - 1] === '\n')
            sliceEnd--;
        if (text[sliceEnd - 1] === '\r')
            sliceEnd--;
        parts.push(body.subarray(start + 1, sliceEnd));
        if (nextIndex === -1 || text.startsWith(`${marker}--`, nextIndex))
            break;
        index = nextIndex;
    }
    return parts;
}
/** RFC 2047 `=?utf-8?B?...?=` encoded words in header values. */
export function decodeHeaderValue(value) {
    if (!value.includes('=?'))
        return value.trim();
    return value
        .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+)(?==\?)/g, '=?$1?$2?$3?=')
        .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset, kind, payload) => {
        try {
            const bytes = kind.toLowerCase() === 'b'
                ? decodeBase64(encodeLatin1(payload))
                : decodeQuotedPrintable(encodeLatin1(payload.replace(/_/g, ' ')));
            return decodeText(bytes, charset).text;
        }
        catch {
            return payload;
        }
    })
        .trim();
}
function latin1(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return out;
}
function encodeLatin1(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
        out[i] = text.charCodeAt(i) & 0xff;
    return out;
}
const BASE64_LOOKUP = (() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const table = new Int16Array(256).fill(-1);
    for (let i = 0; i < chars.length; i++)
        table[chars.charCodeAt(i)] = i;
    return table;
})();
export function decodeBase64(bytes) {
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        const value = BASE64_LOOKUP[byte];
        if (value < 0)
            continue;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}
export function decodeQuotedPrintable(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte !== 0x3d) {
            out.push(byte);
            continue;
        }
        const a = bytes[i + 1];
        const b = bytes[i + 2];
        if (a === 0x0a) {
            i += 1;
            continue;
        }
        if (a === 0x0d && b === 0x0a) {
            i += 2;
            continue;
        }
        const hex = String.fromCharCode(a ?? 0, b ?? 0);
        const value = parseInt(hex, 16);
        if (Number.isFinite(value)) {
            out.push(value);
            i += 2;
        }
        else {
            out.push(byte);
        }
    }
    return Uint8Array.from(out);
}
//# sourceMappingURL=eml.js.map