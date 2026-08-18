import 'package:html/parser.dart' as html_parser;

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/package_archive.dart';
import '../core/xml_query.dart';
import 'html_converter.dart';

/// EPUB (.epub) → Markdown. Mirrors `web/src/converters/epub.ts`.
RawOutput convertEpub(SourceFile file, ConvertOptions options) {
  final archive = DocumentArchive.open(file.bytes);
  final opfPath = _findOpfPath(archive);
  final opf = parseRoot(archive.readText(opfPath));
  if (opf == null) {
    throw const ConversionException('Not an EPUB: the OPF package document is missing.');
  }

  final warnings = <String>[];
  var imageCount = 0;
  final opfDir = (opfPath.split('/')..removeLast()).join('/');

  final manifest = <String, _ManifestItem>{};
  final manifestElement = firstDescendantOf(opf, 'manifest');
  if (manifestElement != null) {
    for (final item in childrenOf(manifestElement, 'item')) {
      final id = attrOf(item, 'id');
      final href = attrOf(item, 'href');
      if (id == null || href == null) continue;
      manifest[id] = _ManifestItem(
        href: normalizePart(opfDir.isEmpty ? '.' : opfDir, Uri.decodeFull(href)),
        type: attrOf(item, 'media-type') ?? '',
        properties: attrOf(item, 'properties') ?? '',
      );
    }
  }

  final spineElement = firstDescendantOf(opf, 'spine');
  final spineIds = spineElement == null
      ? manifest.keys.toList()
      : childrenOf(spineElement, 'itemref')
          .map((ref) => attrOf(ref, 'idref') ?? '')
          .where((id) => id.isNotEmpty)
          .toList();

  final writer = MarkdownWriter();
  var chapterIndex = 0;

  for (final id in spineIds) {
    final item = manifest[id];
    if (item == null) continue;
    if (item.properties.split(RegExp(r'\s+')).contains('nav')) continue;
    if (item.type.isNotEmpty && !RegExp('xhtml|html|xml').hasMatch(item.type)) continue;

    final source = archive.readText(item.href);
    if (source == null) {
      warnings.add('Chapter part missing: ${item.href}');
      continue;
    }

    final chapterDir = (item.href.split('/')..removeLast()).join('/');
    final markdown = htmlToMarkdown(
      html_parser.parse(source),
      HtmlOptions(
        bullet: options.bulletChar,
        onImage: () => imageCount++,
        resolveUrl: (url, kind) {
          if (RegExp(r'^(https?|mailto|tel):', caseSensitive: false).hasMatch(url)) return url;
          if (url.startsWith('#')) return null;
          if (kind == UrlKind.link) return null;
          if (options.imageMode == ImageMode.skip) return null;

          final path = normalizePart(
            chapterDir.isEmpty ? '.' : chapterDir,
            Uri.decodeFull(url.split('#').first),
          );
          if (options.imageMode == ImageMode.reference) return basenameOf(path);

          final bytes = archive.read(path);
          if (bytes == null) {
            warnings.add('Image part not found: $path');
            return null;
          }
          if (bytes.length > options.maxEmbeddedImageBytes) {
            warnings.add('Skipped embedding ${basenameOf(path)} (${formatBytes(bytes.length)}).');
            return basenameOf(path);
          }
          return dataUri(bytes, imageMimeFor(path));
        },
      ),
    );

    if (markdown.trim().isEmpty) continue;
    if (chapterIndex > 0 && options.pageSeparators) writer.rule();
    writer.push(markdown);
    chapterIndex++;
  }

  if (writer.isEmpty) writer.paragraph('_The EPUB contains no readable chapters._');

  final meta = <String, String>{};
  for (final entry in const [
    ['title', 'dc:title'],
    ['author', 'dc:creator'],
    ['language', 'dc:language'],
    ['publisher', 'dc:publisher'],
    ['date', 'dc:date'],
  ]) {
    final matches = descendantsOf(opf, entry[1]);
    final value = matches.isEmpty ? '' : collapseWhitespace(textOf(matches.first)).trim();
    if (value.isNotEmpty) meta[entry[0]] = value;
  }

  return RawOutput(
    markdown: writer.toString(),
    meta: meta,
    warnings: warnings,
    imageCount: imageCount,
  );
}

class _ManifestItem {
  const _ManifestItem({required this.href, required this.type, required this.properties});

  final String href;
  final String type;
  final String properties;
}

String _findOpfPath(DocumentArchive archive) {
  final container = parseRoot(archive.readText('META-INF/container.xml'));
  if (container != null) {
    final rootfile = firstDescendantOf(container, 'rootfile');
    final path = rootfile == null ? null : attrOf(rootfile, 'full-path');
    if (path != null && path.isNotEmpty) return Uri.decodeFull(path);
  }
  for (final name in archive.names) {
    if (name.toLowerCase().endsWith('.opf')) return name;
  }
  throw const ConversionException('Not an EPUB: META-INF/container.xml is missing.');
}
