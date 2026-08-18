import 'package:xml/xml.dart';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/package_archive.dart';
import '../core/xml_query.dart';

/// PowerPoint (.pptx) → Markdown. Mirrors `web/src/converters/pptx.ts`.
RawOutput convertPptx(SourceFile file, ConvertOptions options) {
  final archive = DocumentArchive.open(file.bytes);
  if (!archive.has('ppt/presentation.xml') &&
      archive.namesUnder('ppt/slides/', '.xml').isEmpty) {
    throw const ConversionException(
        'Not a PowerPoint presentation: ppt/presentation.xml is missing.');
  }

  final warnings = <String>[];
  var imageCount = 0;
  final writer = MarkdownWriter();
  final slidePaths = _slideOrder(archive);

  for (var index = 0; index < slidePaths.length; index++) {
    final slidePath = slidePaths[index];
    final root = parseRoot(archive.readText(slidePath));
    if (root == null) {
      warnings.add('Slide part missing: $slidePath');
      continue;
    }
    if (index > 0 && options.pageSeparators) writer.rule();

    final slideRels = readRelationships(archive, relsPathFor(slidePath));
    final shapes = _collectShapes(root, options);

    final title = shapes.where((s) => s.isTitle).firstOrNull;
    writer.heading(2, title != null && title.text.trim().isNotEmpty
        ? title.text.trim()
        : 'Slide ${index + 1}');

    for (final shape in shapes) {
      if (identical(shape, title)) continue;
      if (shape.text.trim().isNotEmpty) writer.push(shape.text);
    }

    for (final pic in descendantsOf(root, 'p:pic')) {
      final markdown = _renderPicture(pic, archive, slideRels, options, warnings);
      if (markdown.isNotEmpty) {
        imageCount++;
        writer.push(markdown);
      }
    }

    if (options.includeNotes) {
      final notes = _readNotes(archive, slideRels);
      if (notes.isNotEmpty) writer.quote('**Speaker notes:** $notes');
    }
  }

  if (writer.isEmpty) writer.paragraph('_The presentation contains no text._');

  return RawOutput(
    markdown: writer.toString(),
    meta: _readMeta(archive),
    warnings: warnings,
    imageCount: imageCount,
  );
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

Map<String, String> _readMeta(DocumentArchive archive) {
  final meta = <String, String>{};
  final root = parseRoot(archive.readText('docProps/core.xml'));
  if (root == null) return meta;
  for (final entry in const [
    ['title', 'dc:title'],
    ['author', 'dc:creator'],
    ['modified', 'dcterms:modified'],
  ]) {
    final element = firstDescendantOf(root, entry[1]);
    final value = element == null ? '' : collapseWhitespace(element.innerText).trim();
    if (value.isNotEmpty) meta[entry[0]] = value;
  }
  return meta;
}

List<String> _slideOrder(DocumentArchive archive) {
  final presentation = parseRoot(archive.readText('ppt/presentation.xml'));
  if (presentation != null) {
    final rels = readRelationships(archive, 'ppt/_rels/presentation.xml.rels');
    final ordered = <String>[];
    for (final sldId in descendantsOf(presentation, 'p:sldId')) {
      final id = attrOf(sldId, 'r:id');
      final rel = id == null ? null : rels[id];
      if (rel == null) continue;
      final path = normalizePart('ppt', rel.target);
      if (archive.has(path)) ordered.add(path);
    }
    if (ordered.isNotEmpty) return ordered;
  }
  return archive
      .namesUnder('ppt/slides/', '.xml')
      .where((name) => RegExp(r'slide\d+\.xml$').hasMatch(name))
      .toList();
}

class _Shape {
  const _Shape({required this.text, required this.isTitle});

  final String text;
  final bool isTitle;
}

List<_Shape> _collectShapes(XmlElement root, ConvertOptions options) {
  final shapes = <_Shape>[];

  void walk(XmlElement element) {
    for (final node in element.children) {
      if (node is! XmlElement) continue;
      if (node.name.qualified == 'p:sp') {
        final placeholder = _placeholderType(node);
        final isTitle =
            placeholder == 'title' || placeholder == 'ctrTitle' || placeholder == 'subTitle';
        shapes.add(_Shape(text: _renderTextBody(node, options, bulleted: !isTitle), isTitle: isTitle));
        continue;
      }
      if (node.name.local == 'tbl') {
        shapes.add(_Shape(text: _renderPptxTable(node), isTitle: false));
        continue;
      }
      walk(node);
    }
  }

  walk(root);
  return shapes;
}

String? _placeholderType(XmlElement shape) {
  final ph = firstDescendantOf(shape, 'p:ph');
  if (ph == null) return null;
  return attrOf(ph, 'type') ?? 'body';
}

String _renderTextBody(XmlElement shape, ConvertOptions options, {bool bulleted = true}) {
  final txBody = childOf(shape, 'p:txBody') ?? firstDescendantOf(shape, 'p:txBody');
  if (txBody == null) return '';

  final lines = <String>[];
  final counters = <int, int>{};

  for (final para in childrenOf(txBody, 'a:p')) {
    final text = _renderParagraphRuns(para);
    if (text.trim().isEmpty) continue;

    if (!bulleted) {
      lines.add(text.trim());
      continue;
    }

    final pPr = childOf(para, 'a:pPr');
    final level = int.tryParse(pPr == null ? '0' : (attrOf(pPr, 'lvl') ?? '0')) ?? 0;
    final noBullet = pPr != null && childOf(pPr, 'a:buNone') != null;
    final autoNum = pPr == null ? null : childOf(pPr, 'a:buAutoNum');

    if (noBullet && level == 0) {
      lines.add(text.trim());
      counters.clear();
      continue;
    }

    final indent = '  ' * level;
    if (autoNum != null) {
      final next = (counters[level] ?? 0) + 1;
      counters[level] = next;
      lines.add('$indent$next. ${text.trim()}');
    } else {
      lines.add('$indent${options.bulletChar} ${text.trim()}');
    }
  }

  return lines.join('\n');
}

String _renderParagraphRuns(XmlElement para) {
  final buffer = StringBuffer();
  for (final node in para.children) {
    if (node is! XmlElement) continue;
    if (node.name.qualified == 'a:br') {
      buffer.write('  \n');
      continue;
    }
    if (node.name.qualified == 'a:fld') {
      final t = childOf(node, 'a:t');
      if (t != null) buffer.write(escapeInline(t.innerText));
      continue;
    }
    if (node.name.qualified != 'a:r') continue;

    final t = childOf(node, 'a:t');
    if (t == null) continue;
    final rPr = childOf(node, 'a:rPr');
    final bold = rPr != null && attrOf(rPr, 'b') == '1';
    final italic = rPr != null && attrOf(rPr, 'i') == '1';
    final strike = rPr != null && (attrOf(rPr, 'strike') ?? 'noStrike') != 'noStrike';

    final raw = t.innerText;
    if (raw.isEmpty) continue;
    if (raw.trim().isEmpty) {
      buffer.write(raw);
      continue;
    }

    final leading = RegExp(r'^\s*').firstMatch(raw)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(raw)!.group(0)!;
    var core = escapeInline(raw.trim());
    if (strike) core = '~~$core~~';
    if (bold) core = '**$core**';
    if (italic) core = '*$core*';
    buffer..write(leading)..write(core)..write(trailing);
  }
  return buffer.toString();
}

String _renderPptxTable(XmlElement tbl) {
  final rows = <List<String>>[];
  for (final tr in childrenOf(tbl, 'a:tr')) {
    final cells = <String>[];
    for (final tc in childrenOf(tr, 'a:tc')) {
      final paragraphs = descendantsOf(tc, 'a:p')
          .map((p) => _renderParagraphRuns(p).trim())
          .where((text) => text.isNotEmpty);
      final span = int.tryParse(attrOf(tc, 'gridSpan') ?? '1') ?? 1;
      cells.add(paragraphs.join('<br>'));
      for (var i = 1; i < span; i++) {
        cells.add('');
      }
    }
    if (cells.isNotEmpty) rows.add(cells);
  }
  if (rows.isEmpty) return '';

  final tblPr = childOf(tbl, 'a:tblPr');
  final hasHeader = tblPr == null || attrOf(tblPr, 'firstRow') == '1';
  if (!hasHeader) rows.insert(0, List<String>.filled(rows.first.length, ''));
  return renderTable(rows);
}

String _renderPicture(
  XmlElement pic,
  DocumentArchive archive,
  Map<String, Relationship> rels,
  ConvertOptions options,
  List<String> warnings,
) {
  if (options.imageMode == ImageMode.skip) return '';

  final blip = firstDescendantOf(pic, 'a:blip');
  final id = blip == null ? null : attrOf(blip, 'r:embed');
  if (id == null) return '';
  final rel = rels[id];
  if (rel == null) return '';

  final nv = firstDescendantOf(pic, 'p:cNvPr');
  final alt = nv == null ? '' : ((attrOf(nv, 'descr') ?? attrOf(nv, 'name')) ?? '').trim();

  if (rel.external) return mdImage(alt.isEmpty ? 'image' : alt, rel.target);

  final path = normalizePart('ppt/slides', rel.target);
  if (options.imageMode == ImageMode.reference) {
    return mdImage(alt.isEmpty ? basenameOf(path) : alt, basenameOf(path));
  }

  final bytes = archive.read(path);
  if (bytes == null) {
    warnings.add('Image part not found: $path');
    return '';
  }
  if (bytes.length > options.maxEmbeddedImageBytes) {
    warnings.add('Skipped embedding ${basenameOf(path)} (${formatBytes(bytes.length)}).');
    return mdImage(alt.isEmpty ? basenameOf(path) : alt, basenameOf(path));
  }
  return mdImage(alt.isEmpty ? basenameOf(path) : alt, dataUri(bytes, imageMimeFor(path)));
}

String _readNotes(DocumentArchive archive, Map<String, Relationship> rels) {
  for (final rel in rels.values) {
    if (!rel.type.endsWith('/notesSlide')) continue;
    final path = normalizePart('ppt/slides', rel.target);
    final root = parseRoot(archive.readText(path));
    if (root == null) continue;

    final texts = <String>[];
    for (final shape in descendantsOf(root, 'p:sp')) {
      if (_placeholderType(shape) == 'sldNum') continue;
      final text = descendantsOf(shape, 'a:t').map((t) => t.innerText).join();
      if (text.trim().isNotEmpty) texts.add(collapseWhitespace(text).trim());
    }
    return texts.join(' ');
  }
  return '';
}
