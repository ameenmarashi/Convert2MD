/** PDF → Markdown. */
import { ConversionError } from '../core/types.js';
import { MarkdownWriter } from '../core/md.js';
import { PdfDocument } from './pdf/document.js';
import { DecryptionError } from './pdf/crypt.js';
import { extractPageText } from './pdf/content.js';
import { bodyFontSize, buildLines, headingSizeLevels, pageToMarkdown, stripRunningHeadersAndFooters, } from './pdf/layout.js';
export function convertPdf(file, options) {
    let doc;
    try {
        doc = PdfDocument.parse(file.bytes);
    }
    catch (err) {
        if (err instanceof DecryptionError)
            throw new ConversionError(err.message);
        throw new ConversionError(`This PDF could not be read: ${err.message}`);
    }
    if (doc.pageCount === 0)
        throw new ConversionError('This PDF has no pages that could be read.');
    const warnings = [...doc.warnings];
    const pages = [];
    for (const page of doc.pages) {
        try {
            pages.push(buildLines(extractPageText(doc, page)));
        }
        catch (err) {
            warnings.push(`Page ${pages.length + 1} could not be read: ${err.message}`);
            pages.push([]);
        }
    }
    stripRunningHeadersAndFooters(pages);
    const bodySize = bodyFontSize(pages);
    const sizeLevels = headingSizeLevels(pages, bodySize);
    const layoutOptions = { bullet: options.bullet, detectHeadings: options.detectPdfHeadings };
    const writer = new MarkdownWriter();
    let emptyPages = 0;
    pages.forEach((lines, index) => {
        const markdown = pageToMarkdown(lines, layoutOptions, bodySize, sizeLevels);
        if (!markdown.trim()) {
            emptyPages++;
            return;
        }
        if (!writer.isEmpty && options.pageSeparators)
            writer.rule();
        writer.push(markdown);
    });
    if (writer.isEmpty) {
        throw new ConversionError('No text could be extracted from this PDF. It is most likely a scan of paper — run it through OCR first, then convert the result.');
    }
    if (emptyPages > 0) {
        warnings.push(`${emptyPages} of ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} held no extractable text (images or scans).`);
    }
    const meta = doc.info();
    meta.pages = String(doc.pageCount);
    return { markdown: writer.toString(), meta, warnings, pageCount: doc.pageCount };
}
//# sourceMappingURL=pdf.js.map