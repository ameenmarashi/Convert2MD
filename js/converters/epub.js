/**
 * EPUB (.epub) → Markdown.
 *
 * Chapters are emitted in spine order and rendered through the shared HTML
 * engine; images referenced from the container are inlined so the Markdown
 * stays readable offline.
 */
import { ZipArchive } from '../core/zip.js';
import { attr, children, descendants, firstDescendant, parseHtml, parseXml, textOf } from '../core/xml.js';
import { collapseWhitespace, dataUri, imageMimeFor, MarkdownWriter, normalizeMarkdown } from '../core/md.js';
import { ConversionError } from '../core/types.js';
import { htmlToMarkdown } from './html.js';
import { basename, formatBytes, normalizePart } from './docx.js';
export function convertEpub(file, options) {
    const zip = ZipArchive.open(file.bytes);
    const opfPath = findOpfPath(zip);
    const opfXml = zip.readText(opfPath);
    if (!opfXml)
        throw new ConversionError('Not an EPUB: the OPF package document is missing.');
    const warnings = [];
    let imageCount = 0;
    const opf = parseXml(opfXml);
    const opfDir = opfPath.split('/').slice(0, -1).join('/');
    const manifest = new Map();
    const manifestEl = firstDescendant(opf, 'manifest');
    if (manifestEl) {
        for (const item of children(manifestEl, 'item')) {
            const id = attr(item, 'id');
            const href = attr(item, 'href');
            if (!id || !href)
                continue;
            manifest.set(id, {
                href: normalizePart(opfDir || '.', decodeURIComponent(href)),
                type: attr(item, 'media-type') ?? '',
                properties: attr(item, 'properties') ?? '',
            });
        }
    }
    const meta = readEpubMeta(opf);
    const writer = new MarkdownWriter();
    const spineEl = firstDescendant(opf, 'spine');
    const spineIds = spineEl
        ? children(spineEl, 'itemref').map((ref) => attr(ref, 'idref') ?? '').filter(Boolean)
        : [...manifest.keys()];
    let chapterIndex = 0;
    for (const id of spineIds) {
        const item = manifest.get(id);
        if (!item)
            continue;
        if (item.properties.split(/\s+/).includes('nav'))
            continue;
        if (item.type && !/xhtml|html|xml/.test(item.type))
            continue;
        const html = zip.readText(item.href);
        if (!html) {
            warnings.push(`Chapter part missing: ${item.href}`);
            continue;
        }
        const chapterDir = item.href.split('/').slice(0, -1).join('/');
        const markdown = htmlToMarkdown(parseHtml(html), {
            bullet: options.bullet,
            onImage: () => {
                imageCount++;
            },
            resolveUrl: (url, kind) => {
                if (/^(https?|mailto|tel):/i.test(url))
                    return url;
                if (url.startsWith('#'))
                    return null;
                if (kind === 'link')
                    return null;
                if (options.imageMode === 'skip')
                    return null;
                const path = normalizePart(chapterDir || '.', decodeURIComponent(url.split('#')[0]));
                if (options.imageMode === 'reference')
                    return basename(path);
                const bytes = zip.read(path);
                if (!bytes) {
                    warnings.push(`Image part not found: ${path}`);
                    return null;
                }
                if (bytes.length > options.maxEmbeddedImageBytes) {
                    warnings.push(`Skipped embedding ${basename(path)} (${formatBytes(bytes.length)}).`);
                    return basename(path);
                }
                return dataUri(bytes, imageMimeFor(path));
            },
        });
        if (!markdown.trim())
            continue;
        if (chapterIndex > 0 && options.pageSeparators)
            writer.rule();
        writer.push(markdown);
        chapterIndex++;
    }
    if (writer.isEmpty)
        writer.paragraph('_The EPUB contains no readable chapters._');
    return { markdown: normalizeMarkdown(writer.toString()), meta, warnings, imageCount };
}
function findOpfPath(zip) {
    const container = zip.readText('META-INF/container.xml');
    if (container) {
        const rootfile = firstDescendant(parseXml(container), 'rootfile');
        const path = rootfile ? attr(rootfile, 'full-path') : null;
        if (path)
            return decodeURIComponent(path);
    }
    const guess = zip.names.find((n) => n.toLowerCase().endsWith('.opf'));
    if (guess)
        return guess;
    throw new ConversionError('Not an EPUB: META-INF/container.xml is missing.');
}
function readEpubMeta(opf) {
    const meta = {};
    const pick = (tag) => {
        const el = descendants(opf, tag)[0];
        return el ? collapseWhitespace(textOf(el)).trim() : '';
    };
    const title = pick('dc:title');
    const author = pick('dc:creator');
    const language = pick('dc:language');
    const publisher = pick('dc:publisher');
    const date = pick('dc:date');
    if (title)
        meta.title = title;
    if (author)
        meta.author = author;
    if (language)
        meta.language = language;
    if (publisher)
        meta.publisher = publisher;
    if (date)
        meta.date = date;
    return meta;
}
//# sourceMappingURL=epub.js.map