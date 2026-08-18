/**
 * Format detection and dispatch.
 *
 * Detection is content-first (magic bytes, and for ZIP containers the parts
 * inside) with the file extension only as a tie-breaker, so a mis-named
 * `.doc` that is really a `.docx` still converts.
 */
import { ConversionError } from './types.js';
import { countWords, normalizeMarkdown, yamlFrontMatter } from './md.js';
import { ZipArchive } from './zip.js';
import { decodeText, looksTextual } from './decode.js';
import { convertDocx } from '../converters/docx.js';
import { convertXlsx } from '../converters/xlsx.js';
import { convertPptx } from '../converters/pptx.js';
import { convertOdf } from '../converters/odf.js';
import { convertEpub } from '../converters/epub.js';
import { convertPdf } from '../converters/pdf.js';
import { convertRtf } from '../converters/rtf.js';
import { convertCsv } from '../converters/csv.js';
import { convertText } from '../converters/text.js';
import { convertEml } from '../converters/eml.js';
import { convertImage } from '../converters/image.js';
import { htmlMeta, htmlStringToMarkdown, htmlTitle } from '../converters/html.js';
import { parseHtml } from './xml.js';
/** Extensions offered in the file picker; detection is not limited to these. */
export const SUPPORTED_EXTENSIONS = [
    '.pdf', '.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.xltx', '.pptx', '.pptm', '.potx',
    '.odt', '.ods', '.odp', '.epub', '.rtf', '.html', '.htm', '.xhtml', '.eml', '.mht', '.mhtml',
    '.csv', '.tsv', '.txt', '.md', '.markdown', '.json', '.jsonl', '.ndjson', '.yaml', '.yml',
    '.xml', '.srt', '.vtt', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.js', '.ts', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.cs',
    '.php', '.sh', '.sql', '.dart', '.toml', '.ini',
];
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff']);
export function detectFormat(file) {
    const bytes = file.bytes;
    const extension = (file.name.split('.').pop() ?? '').toLowerCase();
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46]))
        return { id: 'pdf', label: 'PDF' };
    if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]))
        return { id: 'rtf', label: 'Rich Text (.rtf)' };
    if (ZipArchive.isZip(bytes))
        return detectZip(bytes, extension);
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
        throw new ConversionError('This is a legacy binary Office file (.doc/.xls/.ppt). Open it in Word, Excel or PowerPoint and save as .docx, .xlsx or .pptx, then convert that.');
    }
    if (isImageMagic(bytes) || (IMAGE_EXTENSIONS.has(extension) && extension !== 'svg')) {
        return { id: 'image', label: 'Image' };
    }
    if (extension === 'eml' || extension === 'mht' || extension === 'mhtml') {
        return { id: 'eml', label: 'Email message' };
    }
    if (extension === 'csv' || extension === 'tsv') {
        return { id: 'csv', label: extension === 'tsv' ? 'Tab-separated values' : 'Comma-separated values' };
    }
    if (extension === 'html' || extension === 'htm' || extension === 'xhtml') {
        return { id: 'html', label: 'HTML' };
    }
    if (!looksTextual(bytes)) {
        throw new ConversionError(`“${file.name}” does not look like a document this converter can read. Supported formats include PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, HTML, email, CSV and plain text.`);
    }
    const head = decodeText(bytes.subarray(0, 1024)).text.trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<body')) {
        return { id: 'html', label: 'HTML' };
    }
    if (head.startsWith('from:') || head.startsWith('received:') || head.startsWith('return-path:') || head.startsWith('mime-version:')) {
        return { id: 'eml', label: 'Email message' };
    }
    if (extension === 'svg')
        return { id: 'text', label: 'SVG source' };
    return { id: 'text', label: textLabel(extension) };
}
function detectZip(bytes, extension) {
    let zip;
    try {
        zip = ZipArchive.open(bytes);
    }
    catch (err) {
        throw new ConversionError(`This ZIP-based file could not be opened: ${err.message}`);
    }
    if (zip.has('word/document.xml'))
        return { id: 'docx', label: 'Word (.docx)' };
    if (zip.has('xl/workbook.xml'))
        return { id: 'xlsx', label: 'Excel (.xlsx)' };
    if (zip.has('ppt/presentation.xml'))
        return { id: 'pptx', label: 'PowerPoint (.pptx)' };
    const mimetype = zip.readText('mimetype')?.trim() ?? '';
    if (mimetype === 'application/epub+zip' || zip.has('META-INF/container.xml')) {
        return { id: 'epub', label: 'EPUB' };
    }
    if (mimetype.startsWith('application/vnd.oasis.opendocument') || zip.has('content.xml')) {
        const label = mimetype.includes('spreadsheet')
            ? 'OpenDocument spreadsheet'
            : mimetype.includes('presentation')
                ? 'OpenDocument presentation'
                : 'OpenDocument text';
        return { id: 'odf', label };
    }
    throw new ConversionError(`“.${extension}” is a ZIP archive, but not a document format this converter understands. Unzip it first and convert the files inside.`);
}
function textLabel(extension) {
    switch (extension) {
        case 'md':
        case 'markdown':
            return 'Markdown';
        case 'json':
        case 'jsonl':
        case 'ndjson':
            return 'JSON';
        case 'yaml':
        case 'yml':
            return 'YAML';
        case 'xml':
            return 'XML';
        case 'srt':
        case 'vtt':
            return 'Subtitles';
        case '':
            return 'Plain text';
        default:
            return `Plain text (.${extension})`;
    }
}
function startsWith(bytes, signature) {
    if (bytes.length < signature.length)
        return false;
    return signature.every((byte, index) => bytes[index] === byte);
}
function isImageMagic(bytes) {
    return (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
        startsWith(bytes, [0xff, 0xd8, 0xff]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
        startsWith(bytes, [0x42, 0x4d]) ||
        (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45));
}
export function convertFile(file, options) {
    const started = Date.now();
    const format = detectFormat(file);
    const raw = runConverter(format.id, file, options);
    const meta = { ...(raw.meta ?? {}) };
    const warnings = raw.warnings ?? [];
    let markdown = normalizeMarkdown(raw.markdown);
    if (options.frontMatter) {
        const front = yamlFrontMatter({
            title: meta.title || titleFromName(file.name),
            source_file: file.name,
            source_format: format.label,
            converted: new Date().toISOString().slice(0, 19).replace('T', ' '),
            ...withoutTitle(meta),
        });
        if (front)
            markdown = `${front}\n\n${markdown}`;
    }
    return {
        name: file.name,
        outputName: outputNameFor(file.name),
        format: format.label,
        markdown,
        warnings,
        meta,
        imageCount: raw.imageCount ?? 0,
        wordCount: countWords(raw.markdown),
        durationMs: Date.now() - started,
    };
}
function runConverter(id, file, options) {
    switch (id) {
        case 'docx':
            return convertDocx(file, options);
        case 'xlsx':
            return convertXlsx(file, options);
        case 'pptx':
            return convertPptx(file, options);
        case 'odf':
            return convertOdf(file, options);
        case 'epub':
            return convertEpub(file, options);
        case 'pdf':
            return convertPdf(file, options);
        case 'rtf':
            return convertRtf(file, options);
        case 'csv':
            return convertCsv(file, options);
        case 'eml':
            return convertEml(file, options);
        case 'image':
            return convertImage(file, options);
        case 'html':
            return convertHtmlFile(file, options);
        case 'text':
        default:
            return convertText(file, options);
    }
}
function convertHtmlFile(file, options) {
    const { text, encoding } = decodeText(file.bytes, charsetFromHtml(file.bytes));
    const root = parseHtml(text);
    let imageCount = 0;
    const markdown = htmlStringToMarkdown(text, {
        bullet: options.bullet,
        onImage: () => {
            imageCount++;
        },
        resolveUrl: (url, kind) => {
            if (kind === 'image' && options.imageMode === 'skip')
                return null;
            return url;
        },
    });
    const meta = { encoding, ...htmlMeta(root) };
    const title = htmlTitle(root);
    if (title)
        meta.title = title;
    return { markdown, meta, warnings: [], imageCount };
}
function charsetFromHtml(bytes) {
    const head = decodeText(bytes.subarray(0, 2048)).text;
    const match = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) ??
        head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i);
    return match ? match[1] : undefined;
}
function withoutTitle(meta) {
    const copy = { ...meta };
    delete copy.title;
    return copy;
}
export function titleFromName(name) {
    return name
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
export function outputNameFor(name) {
    const base = name.replace(/\.[^.]+$/, '') || 'document';
    return `${base}.md`;
}
//# sourceMappingURL=convert.js.map