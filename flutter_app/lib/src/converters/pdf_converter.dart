import '../core/conversion.dart';
import '../core/markdown.dart';
import 'pdf/content.dart';
import 'pdf/crypt.dart';
import 'pdf/document.dart';
import 'pdf/layout.dart';

/// PDF → Markdown. Mirrors `web/src/converters/pdf.ts`.
RawOutput convertPdf(SourceFile file, ConvertOptions options) {
  final PdfDocument doc;
  try {
    doc = PdfDocument.parse(file.bytes);
  } on DecryptionException catch (error) {
    throw ConversionException(error.message);
  } catch (error) {
    throw ConversionException('This PDF could not be read: $error');
  }

  if (doc.pageCount == 0) {
    throw const ConversionException('This PDF has no pages that could be read.');
  }

  final warnings = <String>[...doc.warnings];
  final pages = <List<Line>>[];

  for (final page in doc.pages) {
    try {
      pages.add(buildLines(extractPageText(doc, page)));
    } catch (error) {
      warnings.add('Page ${pages.length + 1} could not be read: $error');
      pages.add(const <Line>[]);
    }
  }

  stripRunningHeadersAndFooters(pages);

  final bodySize = bodyFontSize(pages);
  final sizeLevels = headingSizeLevels(pages, bodySize);
  final layoutOptions = PdfLayoutOptions(
    bullet: options.bulletChar,
    detectHeadings: options.detectPdfHeadings,
  );

  final writer = MarkdownWriter();
  var emptyPages = 0;

  for (final lines in pages) {
    final markdown = pageToMarkdown(lines, layoutOptions, bodySize, sizeLevels);
    if (markdown.trim().isEmpty) {
      emptyPages++;
      continue;
    }
    if (!writer.isEmpty && options.pageSeparators) writer.rule();
    writer.push(markdown);
  }

  if (writer.isEmpty) {
    throw const ConversionException(
      'No text could be extracted from this PDF. It is most likely a scan of paper — '
      'run it through OCR first, then convert the result.',
    );
  }
  if (emptyPages > 0) {
    warnings.add(
      '$emptyPages of ${doc.pageCount} page${doc.pageCount == 1 ? '' : 's'} '
      'held no extractable text (images or scans).',
    );
  }

  final meta = doc.info();
  meta['pages'] = '${doc.pageCount}';

  return RawOutput(markdown: writer.toString(), meta: meta, warnings: warnings);
}
