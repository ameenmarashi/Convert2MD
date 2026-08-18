import 'dart:typed_data';

import '../converters/csv_converter.dart';
import '../converters/docx_converter.dart';
import '../converters/eml_converter.dart';
import '../converters/epub_converter.dart';
import '../converters/html_converter.dart';
import '../converters/image_converter.dart';
import '../converters/odf_converter.dart';
import '../converters/pdf_converter.dart';
import '../converters/pptx_converter.dart';
import '../converters/rtf_converter.dart';
import '../converters/text_converter.dart';
import '../converters/xlsx_converter.dart';
import 'conversion.dart';
import 'markdown.dart';
import 'package_archive.dart';
import 'text_decode.dart';

/// Format detection and dispatch. Detection is content-first (magic bytes, and
/// for ZIP containers the parts inside) with the file extension only as a
/// tie-breaker, so a mis-named `.doc` that is really a `.docx` still converts.
/// Mirrors `web/src/core/convert.ts`.
enum FormatId { docx, xlsx, pptx, odf, epub, pdf, rtf, html, csv, eml, image, text }

class FormatInfo {
  const FormatInfo(this.id, this.label);

  final FormatId id;
  final String label;
}

/// Extensions offered in the file picker; detection is not limited to these.
const List<String> supportedExtensions = [
  'pdf', 'docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx', 'pptx', 'pptm', 'potx',
  'odt', 'ods', 'odp', 'epub', 'rtf', 'html', 'htm', 'xhtml', 'eml', 'mht', 'mhtml',
  'csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'xml', 'srt', 'vtt', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs',
  'php', 'sh', 'sql', 'dart', 'toml', 'ini',
];

const Set<String> _imageExtensions = {
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff',
};

/// Google Drive shortcut files hold a link, not the document itself.
const Map<String, String> _driveShortcuts = {
  'gdoc': 'Google Docs',
  'gsheet': 'Google Sheets',
  'gslides': 'Google Slides',
  'gdraw': 'Google Drawings',
};

FormatInfo detectFormat(SourceFile file) {
  final bytes = file.bytes;
  final extension = file.name.contains('.') ? file.name.split('.').last.toLowerCase() : '';

  final shortcut = _driveShortcuts[extension];
  if (shortcut != null) {
    throw ConversionException(
      'A .$extension file is only a link to a document stored in Google Drive, so there is '
      'nothing to convert. Open it in $shortcut and choose File → Download → '
      '${extension == 'gsheet' ? 'Microsoft Excel (.xlsx)' : extension == 'gslides' ? 'Microsoft PowerPoint (.pptx)' : 'Microsoft Word (.docx)'}, '
      'then convert that file.',
    );
  }

  if (_startsWith(bytes, const [0x25, 0x50, 0x44, 0x46])) return const FormatInfo(FormatId.pdf, 'PDF');
  if (_startsWith(bytes, const [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return const FormatInfo(FormatId.rtf, 'Rich Text (.rtf)');
  }

  if (DocumentArchive.isZip(bytes)) return _detectZip(bytes, extension);

  if (_startsWith(bytes, const [0xd0, 0xcf, 0x11, 0xe0])) {
    throw const ConversionException(
      'This is a legacy binary Office file (.doc/.xls/.ppt). Open it in Word, Excel or '
      'PowerPoint and save as .docx, .xlsx or .pptx, then convert that.',
    );
  }

  if (_isImageMagic(bytes) || (_imageExtensions.contains(extension) && extension != 'svg')) {
    return const FormatInfo(FormatId.image, 'Image');
  }

  if (extension == 'eml' || extension == 'mht' || extension == 'mhtml') {
    return const FormatInfo(FormatId.eml, 'Email message');
  }
  if (extension == 'csv' || extension == 'tsv') {
    return FormatInfo(
      FormatId.csv,
      extension == 'tsv' ? 'Tab-separated values' : 'Comma-separated values',
    );
  }
  if (extension == 'html' || extension == 'htm' || extension == 'xhtml') {
    return const FormatInfo(FormatId.html, 'HTML');
  }

  if (!looksTextual(bytes)) {
    throw ConversionException(
      '“${file.name}” does not look like a document this converter can read. Supported '
      'formats include PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, HTML, email, '
      'CSV and plain text.',
    );
  }

  final head = decodeText(Uint8List.sublistView(bytes, 0, bytes.length < 1024 ? bytes.length : 1024))
      .text
      .trimLeft()
      .toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.contains('<body')) {
    return const FormatInfo(FormatId.html, 'HTML');
  }
  if (head.startsWith('from:') ||
      head.startsWith('received:') ||
      head.startsWith('return-path:') ||
      head.startsWith('mime-version:')) {
    return const FormatInfo(FormatId.eml, 'Email message');
  }
  if (extension == 'svg') return const FormatInfo(FormatId.text, 'SVG source');

  return FormatInfo(FormatId.text, _textLabel(extension));
}

FormatInfo _detectZip(Uint8List bytes, String extension) {
  final archive = DocumentArchive.open(bytes);

  if (archive.has('word/document.xml')) return const FormatInfo(FormatId.docx, 'Word (.docx)');
  if (archive.has('xl/workbook.xml')) return const FormatInfo(FormatId.xlsx, 'Excel (.xlsx)');
  if (archive.has('ppt/presentation.xml')) {
    return const FormatInfo(FormatId.pptx, 'PowerPoint (.pptx)');
  }

  final mimetype = archive.readText('mimetype')?.trim() ?? '';
  if (mimetype == 'application/epub+zip' || archive.has('META-INF/container.xml')) {
    return const FormatInfo(FormatId.epub, 'EPUB');
  }
  if (mimetype.startsWith('application/vnd.oasis.opendocument') || archive.has('content.xml')) {
    final label = mimetype.contains('spreadsheet')
        ? 'OpenDocument spreadsheet'
        : mimetype.contains('presentation')
            ? 'OpenDocument presentation'
            : 'OpenDocument text';
    return FormatInfo(FormatId.odf, label);
  }

  throw ConversionException(
    '“.$extension” is a ZIP archive, but not a document format this converter understands. '
    'Unzip it first and convert the files inside.',
  );
}

String _textLabel(String extension) {
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
      return 'Plain text (.$extension)';
  }
}

bool _startsWith(Uint8List bytes, List<int> signature) {
  if (bytes.length < signature.length) return false;
  for (var i = 0; i < signature.length; i++) {
    if (bytes[i] != signature[i]) return false;
  }
  return true;
}

bool _isImageMagic(Uint8List bytes) {
  return _startsWith(bytes, const [0x89, 0x50, 0x4e, 0x47]) ||
      _startsWith(bytes, const [0xff, 0xd8, 0xff]) ||
      _startsWith(bytes, const [0x47, 0x49, 0x46, 0x38]) ||
      _startsWith(bytes, const [0x42, 0x4d]) ||
      (_startsWith(bytes, const [0x52, 0x49, 0x46, 0x46]) &&
          bytes.length > 10 &&
          bytes[8] == 0x57 &&
          bytes[9] == 0x45);
}

ConversionResult convertFile(SourceFile file, ConvertOptions options) {
  final started = DateTime.now();
  final format = detectFormat(file);
  final raw = _runConverter(format.id, file, options);

  final meta = Map<String, String>.from(raw.meta);
  var markdown = normalizeMarkdown(raw.markdown);

  if (options.frontMatter) {
    final title = meta['title']?.isNotEmpty == true ? meta['title']! : titleFromName(file.name);
    final front = yamlFrontMatter(<String, String>{
      'title': title,
      'source_file': file.name,
      'source_format': format.label,
      'converted': DateTime.now().toIso8601String().substring(0, 19).replaceFirst('T', ' '),
      ...Map<String, String>.from(meta)..remove('title'),
    });
    if (front.isNotEmpty) markdown = '$front\n\n$markdown';
  }

  return ConversionResult(
    name: file.name,
    outputName: outputNameFor(file.name),
    format: format.label,
    markdown: markdown,
    warnings: raw.warnings,
    meta: meta,
    imageCount: raw.imageCount,
    wordCount: countWords(raw.markdown),
    durationMs: DateTime.now().difference(started).inMilliseconds,
  );
}

RawOutput _runConverter(FormatId id, SourceFile file, ConvertOptions options) {
  switch (id) {
    case FormatId.docx:
      return convertDocx(file, options);
    case FormatId.xlsx:
      return convertXlsx(file, options);
    case FormatId.pptx:
      return convertPptx(file, options);
    case FormatId.odf:
      return convertOdf(file, options);
    case FormatId.epub:
      return convertEpub(file, options);
    case FormatId.pdf:
      return convertPdf(file, options);
    case FormatId.rtf:
      return convertRtf(file, options);
    case FormatId.csv:
      return convertCsv(file, options);
    case FormatId.eml:
      return convertEml(file, options);
    case FormatId.image:
      return convertImage(file, options);
    case FormatId.html:
      return _convertHtmlFile(file, options);
    case FormatId.text:
      return convertText(file, options);
  }
}

RawOutput _convertHtmlFile(SourceFile file, ConvertOptions options) {
  final decoded = decodeText(file.bytes, _charsetFromHtml(file.bytes));
  var imageCount = 0;

  final document = parseHtmlDocument(decoded.text);
  final markdown = htmlToMarkdown(
    document,
    HtmlOptions(
      bullet: options.bulletChar,
      onImage: () => imageCount++,
      resolveUrl: (url, kind) =>
          kind == UrlKind.image && options.imageMode == ImageMode.skip ? null : url,
    ),
  );

  final meta = <String, String>{'encoding': decoded.encoding, ...htmlMeta(document)};
  final title = htmlTitle(document);
  if (title.isNotEmpty) meta['title'] = title;

  return RawOutput(markdown: markdown, meta: meta, imageCount: imageCount);
}

String? _charsetFromHtml(Uint8List bytes) {
  final head =
      decodeText(Uint8List.sublistView(bytes, 0, bytes.length < 2048 ? bytes.length : 2048)).text;
  final meta = RegExp(r'''<meta[^>]+charset\s*=\s*["']?([\w-]+)''', caseSensitive: false)
      .firstMatch(head);
  if (meta != null) return meta.group(1);
  final xml = RegExp(r'''<\?xml[^>]+encoding\s*=\s*["']([\w-]+)''', caseSensitive: false)
      .firstMatch(head);
  return xml?.group(1);
}

String titleFromName(String name) => name
    .replaceFirst(RegExp(r'\.[^.]+$'), '')
    .replaceAll(RegExp(r'[_-]+'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

String outputNameFor(String name) {
  final base = name.replaceFirst(RegExp(r'\.[^.]+$'), '');
  return '${base.isEmpty ? 'document' : base}.md';
}
