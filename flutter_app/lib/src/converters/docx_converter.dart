import 'package:xml/xml.dart';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/package_archive.dart';
import '../core/xml_query.dart';

/// Word (.docx) → Markdown. Mirrors `web/src/converters/docx.ts`.
RawOutput convertDocx(SourceFile file, ConvertOptions options) {
  final archive = DocumentArchive.open(file.bytes);
  final documentXml = archive.readText('word/document.xml');
  if (documentXml == null) {
    throw const ConversionException('Not a Word document: word/document.xml is missing.');
  }

  final root = parseRoot(documentXml);
  final body = root == null ? null : firstDescendantOf(root, 'w:body');
  if (body == null) throw const ConversionException('Word document has no body.');

  final context = _DocxContext(archive, options);
  final writer = MarkdownWriter();
  context.renderBlockContainer(body, writer, 0);
  context.appendNotes(writer);

  return RawOutput(
    markdown: writer.toString(),
    meta: context.readMeta(),
    warnings: context.warnings,
    imageCount: context.imageCount,
  );
}

class _Segment {
  _Segment({
    required this.text,
    this.bold = false,
    this.italic = false,
    this.strike = false,
    this.code = false,
    this.sup = false,
    this.sub = false,
    this.href,
  });

  String text;
  final bool bold;
  final bool italic;
  final bool strike;
  final bool code;
  final bool sup;
  final bool sub;
  final String? href;

  bool sameFormat(_Segment other) =>
      bold == other.bold &&
      italic == other.italic &&
      strike == other.strike &&
      code == other.code &&
      sup == other.sup &&
      sub == other.sub &&
      href == other.href;

  _Segment copy() => _Segment(
        text: text,
        bold: bold,
        italic: italic,
        strike: strike,
        code: code,
        sup: sup,
        sub: sub,
        href: href,
      );
}

class _RunFormat {
  const _RunFormat({
    this.bold = false,
    this.italic = false,
    this.strike = false,
    this.code = false,
    this.sup = false,
    this.sub = false,
    this.href,
  });

  final bool bold;
  final bool italic;
  final bool strike;
  final bool code;
  final bool sup;
  final bool sub;
  final String? href;

  _RunFormat withHref(String? value) => _RunFormat(
        bold: bold,
        italic: italic,
        strike: strike,
        code: code,
        sup: sup,
        sub: sub,
        href: value,
      );
}

class _ListLevel {
  const _ListLevel({required this.ordered, required this.start});

  final bool ordered;
  final int start;
}

class _ParagraphResult {
  const _ParagraphResult({this.block = '', this.listLine, this.pageBreak = false});

  final String block;
  final String? listLine;
  final bool pageBreak;
}

class _DocxContext {
  _DocxContext(this.archive, this.options)
      : rels = readRelationships(archive, 'word/_rels/document.xml.rels') {
    _readStyles();
    _readNumbering();
    _readNotes();
  }

  final DocumentArchive archive;
  final ConvertOptions options;
  final Map<String, Relationship> rels;

  final List<String> warnings = <String>[];
  int imageCount = 0;

  final Map<String, String> _styleNames = <String, String>{};
  final Map<String, _ListLevel> _listLevels = <String, _ListLevel>{};
  final Map<String, int> _counters = <String, int>{};
  final Map<String, String> _comments = <String, String>{};
  final List<MapEntry<String, String>> _usedNotes = <MapEntry<String, String>>[];
  XmlElement? _footnotesRoot;
  XmlElement? _endnotesRoot;

  Map<String, String> readMeta() {
    final meta = <String, String>{};
    final core = parseRoot(archive.readText('docProps/core.xml'));
    if (core != null) {
      void take(String key, String tag) {
        final element = firstDescendantOf(core, tag);
        final value = element == null ? '' : collapseWhitespace(element.innerText).trim();
        if (value.isNotEmpty) meta[key] = value;
      }

      take('title', 'dc:title');
      take('author', 'dc:creator');
      take('subject', 'dc:subject');
      take('keywords', 'cp:keywords');
      take('created', 'dcterms:created');
      take('modified', 'dcterms:modified');
    }

    final app = parseRoot(archive.readText('docProps/app.xml'));
    final company = app == null ? null : firstDescendantOf(app, 'Company');
    if (company != null && company.innerText.trim().isNotEmpty) {
      meta['company'] = company.innerText.trim();
    }
    return meta;
  }

  void _readStyles() {
    final root = parseRoot(archive.readText('word/styles.xml'));
    if (root == null) return;
    for (final style in descendantsOf(root, 'w:style')) {
      final id = attrOf(style, 'w:styleId');
      if (id == null) continue;
      final nameElement = childOf(style, 'w:name');
      final name = nameElement == null ? '' : (attrOf(nameElement, 'w:val') ?? '');
      _styleNames[id] = name.isEmpty ? id : name;
    }
  }

  void _readNumbering() {
    final root = parseRoot(archive.readText('word/numbering.xml'));
    if (root == null) return;

    final abstract = <String, Map<int, _ListLevel>>{};
    for (final abs in descendantsOf(root, 'w:abstractNum')) {
      final id = attrOf(abs, 'w:abstractNumId');
      if (id == null) continue;
      final levels = <int, _ListLevel>{};
      for (final lvl in childrenOf(abs, 'w:lvl')) {
        final ilvl = int.tryParse(attrOf(lvl, 'w:ilvl') ?? '0') ?? 0;
        final fmtElement = childOf(lvl, 'w:numFmt');
        final fmt = fmtElement == null ? 'bullet' : (attrOf(fmtElement, 'w:val') ?? 'bullet');
        final startElement = childOf(lvl, 'w:start');
        final start = int.tryParse(startElement == null ? '1' : (attrOf(startElement, 'w:val') ?? '1')) ?? 1;
        levels[ilvl] = _ListLevel(ordered: fmt != 'bullet' && fmt != 'none', start: start);
      }
      abstract[id] = levels;
    }

    for (final num in descendantsOf(root, 'w:num')) {
      final numId = attrOf(num, 'w:numId');
      final absRef = childOf(num, 'w:abstractNumId');
      final absId = absRef == null ? null : attrOf(absRef, 'w:val');
      if (numId == null || absId == null) continue;
      final levels = abstract[absId];
      if (levels == null) continue;
      levels.forEach((ilvl, level) => _listLevels['$numId:$ilvl'] = level);
    }
  }

  void _readNotes() {
    _footnotesRoot = parseRoot(archive.readText('word/footnotes.xml'));
    _endnotesRoot = parseRoot(archive.readText('word/endnotes.xml'));
    final comments = parseRoot(archive.readText('word/comments.xml'));
    if (comments != null) {
      for (final comment in descendantsOf(comments, 'w:comment')) {
        final id = attrOf(comment, 'w:id');
        if (id != null) _comments[id] = _plainText(comment);
      }
    }
  }

  String _plainText(XmlElement element) {
    final paragraphs = descendantsOf(element, 'w:p')
        .map((p) => descendantsOf(p, 'w:t').map((t) => t.innerText).join())
        .join(' ');
    return collapseWhitespace(paragraphs).trim();
  }

  String _noteText(XmlElement? source, String tag, String id) {
    if (source == null) return '';
    for (final note in descendantsOf(source, tag)) {
      if (attrOf(note, 'w:id') == id) return _plainText(note);
    }
    return '';
  }

  void renderBlockContainer(XmlElement container, MarkdownWriter writer, int depth) {
    var listBuffer = <String>[];

    void flushList() {
      if (listBuffer.isEmpty) return;
      writer.push(listBuffer.join('\n'));
      listBuffer = <String>[];
    }

    for (final node in container.children) {
      if (node is! XmlElement) continue;

      switch (node.name.local) {
        case 'p':
          final rendered = _renderParagraph(node, depth);
          if (rendered.listLine != null) {
            listBuffer.add(rendered.listLine!);
          } else {
            flushList();
            _counters.clear();
            if (rendered.block.isNotEmpty) writer.push(rendered.block);
            if (rendered.pageBreak && options.pageSeparators) writer.rule();
          }
        case 'tbl':
          flushList();
          _counters.clear();
          writer.push(_renderTable(node));
        case 'sdt':
          final content = childOf(node, 'w:sdtContent');
          if (content != null) {
            flushList();
            renderBlockContainer(content, writer, depth);
          }
        default:
          break;
      }
    }
    flushList();
  }

  _ParagraphResult _renderParagraph(XmlElement p, int depth) {
    final pPr = childOf(p, 'w:pPr');
    final segments = collectSegments(p);
    final text = _emitSegments(segments);
    final pageBreak =
        descendantsOf(p, 'w:br').any((br) => attrOf(br, 'w:type') == 'page');

    if (text.trim().isEmpty && !segments.any((s) => s.text.startsWith('!['))) {
      return _ParagraphResult(pageBreak: pageBreak);
    }

    final numPr = pPr == null ? null : childOf(pPr, 'w:numPr');
    if (numPr != null) {
      final line = _renderListItem(numPr, text, depth);
      if (line != null) return _ParagraphResult(listLine: line, pageBreak: pageBreak);
    }

    final heading = _headingLevel(pPr);
    if (heading > 0) {
      return _ParagraphResult(
        block: '${'#' * heading} ${text.replaceAll(RegExp(r'\n+'), ' ').trim()}',
        pageBreak: pageBreak,
      );
    }

    final styleId = _styleId(pPr);
    final styleName = (styleId == null ? '' : (_styleNames[styleId] ?? styleId)).toLowerCase();

    if (styleName.contains('quote')) {
      final quoted = text.split('\n').map((l) => l.isEmpty ? '>' : '> $l').join('\n');
      return _ParagraphResult(block: quoted, pageBreak: pageBreak);
    }
    if (styleName.contains('code') || styleName == 'html preformatted') {
      return _ParagraphResult(block: '```\n${_stripInlineMarkup(text)}\n```', pageBreak: pageBreak);
    }
    if (styleName == 'caption') {
      return _ParagraphResult(block: '*${text.trim()}*', pageBreak: pageBreak);
    }

    return _ParagraphResult(block: text.trim(), pageBreak: pageBreak);
  }

  String? _renderListItem(XmlElement numPr, String text, int depth) {
    final numIdElement = childOf(numPr, 'w:numId');
    final ilvlElement = childOf(numPr, 'w:ilvl');
    final numId = numIdElement == null ? '' : (attrOf(numIdElement, 'w:val') ?? '');
    final ilvl = int.tryParse(ilvlElement == null ? '0' : (attrOf(ilvlElement, 'w:val') ?? '0')) ?? 0;
    if (numId.isEmpty || numId == '0') return null;

    final level = _listLevels['$numId:$ilvl'] ?? const _ListLevel(ordered: false, start: 1);
    final indent = '  ' * (ilvl + depth);

    final String marker;
    if (level.ordered) {
      final key = '$numId:$ilvl';
      final next = (_counters[key] ?? level.start - 1) + 1;
      _counters[key] = next;
      _counters.removeWhere((existing, _) {
        final existingLevel = int.tryParse(existing.split(':')[1]) ?? 0;
        return existingLevel > ilvl;
      });
      marker = '$next.';
    } else {
      marker = options.bulletChar;
    }

    final body = text.trim().replaceAll('\n', '\n$indent${' ' * (marker.length + 1)}');
    return '$indent$marker $body';
  }

  String? _styleId(XmlElement? pPr) {
    if (pPr == null) return null;
    final style = childOf(pPr, 'w:pStyle');
    return style == null ? null : attrOf(style, 'w:val');
  }

  int _headingLevel(XmlElement? pPr) {
    if (pPr == null) return 0;
    final styleId = _styleId(pPr);
    if (styleId != null) {
      final name = (_styleNames[styleId] ?? styleId).toLowerCase().replaceAll(RegExp(r'\s+'), '');
      final match = RegExp(r'^heading([1-9])$').firstMatch(name);
      if (match != null) {
        final level = int.parse(match.group(1)!);
        return level > 6 ? 6 : level;
      }
      if (name == 'title') return 1;
      if (name == 'subtitle') return 2;
    }
    final outline = childOf(pPr, 'w:outlineLvl');
    if (outline != null) {
      final level = int.tryParse(attrOf(outline, 'w:val') ?? '');
      if (level != null && level >= 0 && level <= 8) return (level + 1).clamp(1, 6);
    }
    return 0;
  }

  List<_Segment> collectSegments(XmlElement container) {
    final segments = <_Segment>[];
    String? fieldInstruction;
    String? fieldHref;

    void walk(XmlElement element, _RunFormat format) {
      for (final node in element.children) {
        if (node is! XmlElement) continue;

        switch (node.name.local) {
          case 'r':
            final runFormat = _runFormat(node, format);
            for (final part in node.children) {
              if (part is! XmlElement) continue;
              switch (part.name.local) {
                case 't':
                  segments.add(_makeSegment(part.innerText, runFormat, fieldHref ?? format.href));
                case 'tab':
                  segments.add(_makeSegment('\t', runFormat, null));
                case 'br':
                  if (attrOf(part, 'w:type') != 'page') {
                    segments.add(_makeSegment('\n', runFormat, null));
                  }
                case 'cr':
                  segments.add(_makeSegment('\n', runFormat, null));
                case 'noBreakHyphen':
                  segments.add(_makeSegment('-', runFormat, null));
                case 'sym':
                  segments.add(_makeSegment(_symbolChar(part), runFormat, null));
                case 'drawing':
                case 'pict':
                case 'object':
                  final markdown = _renderImage(part);
                  if (markdown.isNotEmpty) {
                    segments.add(_Segment(text: markdown));
                  }
                case 'footnoteReference':
                  final id = attrOf(part, 'w:id') ?? '';
                  final text = _noteText(_footnotesRoot, 'w:footnote', id);
                  if (text.isNotEmpty) {
                    final marker = 'fn${_usedNotes.length + 1}';
                    _usedNotes.add(MapEntry(marker, text));
                    segments.add(_Segment(text: '[^$marker]'));
                  }
                case 'endnoteReference':
                  final id = attrOf(part, 'w:id') ?? '';
                  final text = _noteText(_endnotesRoot, 'w:endnote', id);
                  if (text.isNotEmpty) {
                    final marker = 'en${_usedNotes.length + 1}';
                    _usedNotes.add(MapEntry(marker, text));
                    segments.add(_Segment(text: '[^$marker]'));
                  }
                case 'instrText':
                  if (fieldInstruction != null) fieldInstruction = fieldInstruction! + part.innerText;
                case 'fldChar':
                  final type = attrOf(part, 'w:fldCharType');
                  if (type == 'begin') {
                    fieldInstruction = '';
                    fieldHref = null;
                  } else if (type == 'separate') {
                    fieldHref = _parseHyperlinkField(fieldInstruction ?? '');
                    fieldInstruction = null;
                  } else if (type == 'end') {
                    fieldHref = null;
                    fieldInstruction = null;
                  }
                default:
                  break;
              }
            }
          case 'hyperlink':
            walk(node, format.withHref(_hyperlinkTarget(node)));
          case 'ins':
          case 'smartTag':
          case 'sdtContent':
          case 'bdo':
          case 'dir':
            walk(node, format);
          case 'sdt':
            final content = childOf(node, 'w:sdtContent');
            if (content != null) walk(content, format);
          case 'fldSimple':
            final href = _parseHyperlinkField(attrOf(node, 'w:instr') ?? '');
            walk(node, href == null ? format : format.withHref(href));
          case 'commentReference':
            if (!options.includeNotes) break;
            final id = attrOf(node, 'w:id') ?? '';
            final text = _comments[id];
            if (text != null && text.isNotEmpty) {
              segments.add(_Segment(text: ' <!-- comment: $text --> '));
            }
          case 'del':
          case 'delText':
            break;
          default:
            break;
        }
      }
    }

    walk(container, const _RunFormat());
    return segments;
  }

  _Segment _makeSegment(String text, _RunFormat format, String? href) {
    return _Segment(
      text: escapeInline(text),
      bold: format.bold,
      italic: format.italic,
      strike: format.strike,
      code: format.code,
      sup: format.sup,
      sub: format.sub,
      href: href ?? format.href,
    );
  }

  _RunFormat _runFormat(XmlElement run, _RunFormat inherited) {
    final rPr = childOf(run, 'w:rPr');
    if (rPr == null) return inherited;

    bool on(String name) {
      final element = childOf(rPr, name);
      if (element == null) return false;
      final value = attrOf(element, 'w:val');
      return value == null || value == '1' || value == 'true' || value == 'on';
    }

    final vertAlign = childOf(rPr, 'w:vertAlign');
    final align = vertAlign == null ? null : attrOf(vertAlign, 'w:val');
    final styleElement = childOf(rPr, 'w:rStyle');
    final styleId = styleElement == null ? '' : (attrOf(styleElement, 'w:val') ?? '');
    final styleName = (_styleNames[styleId] ?? styleId).toLowerCase();
    final fonts = childOf(rPr, 'w:rFonts');
    final ascii = fonts == null ? '' : (attrOf(fonts, 'w:ascii') ?? '').toLowerCase();

    return _RunFormat(
      bold: on('w:b') || on('w:bCs'),
      italic: on('w:i') || on('w:iCs'),
      strike: on('w:strike') || on('w:dstrike'),
      sup: align == 'superscript',
      sub: align == 'subscript',
      code: styleName.contains('code') ||
          ascii.contains('consolas') ||
          ascii.contains('courier') ||
          ascii.contains('mono'),
      href: inherited.href,
    );
  }

  String? _hyperlinkTarget(XmlElement element) {
    final id = attrOf(element, 'r:id');
    if (id != null) {
      final rel = rels[id];
      if (rel != null) return rel.target;
    }
    final anchor = attrOf(element, 'w:anchor');
    return anchor == null ? null : '#$anchor';
  }

  String _renderImage(XmlElement element) {
    if (options.imageMode == ImageMode.skip) return '';

    final blip = firstDescendantOf(element, 'a:blip') ?? firstDescendantOf(element, 'v:imagedata');
    final id = blip == null ? null : (attrOf(blip, 'r:embed') ?? attrOf(blip, 'r:id'));
    final docPr = firstDescendantOf(element, 'wp:docPr');
    final alt = docPr == null
        ? ''
        : ((attrOf(docPr, 'descr') ?? attrOf(docPr, 'name')) ?? '').trim();

    if (id == null) return '';
    final rel = rels[id];
    if (rel == null) return '';

    if (rel.external) {
      imageCount++;
      return mdImage(alt.isEmpty ? 'image' : alt, rel.target);
    }

    final path = normalizePart('word', rel.target);
    if (options.imageMode == ImageMode.reference) {
      imageCount++;
      return mdImage(alt.isEmpty ? basenameOf(path) : alt, path.replaceFirst('word/', ''));
    }

    final bytes = archive.read(path);
    if (bytes == null) {
      warnings.add('Image part not found: $path');
      return '';
    }
    if (bytes.length > options.maxEmbeddedImageBytes) {
      warnings.add(
          'Skipped embedding ${basenameOf(path)} (${formatBytes(bytes.length)} exceeds the inline image limit).');
      return mdImage(alt.isEmpty ? basenameOf(path) : alt, basenameOf(path));
    }
    imageCount++;
    return mdImage(alt.isEmpty ? basenameOf(path) : alt, dataUri(bytes, imageMimeFor(path)));
  }

  String _renderTable(XmlElement tbl) {
    final rows = <List<String>>[];
    var headerRows = 0;

    for (final tr in childrenOf(tbl, 'w:tr')) {
      final cells = <String>[];
      final trPr = childOf(tr, 'w:trPr');
      final isHeader = trPr != null && childOf(trPr, 'w:tblHeader') != null;

      for (final tc in childrenOf(tr, 'w:tc')) {
        final parts = <String>[];
        for (final node in tc.children) {
          if (node is! XmlElement) continue;
          if (node.name.local == 'p') {
            final text = _emitSegments(collectSegments(node)).trim();
            if (text.isNotEmpty) parts.add(text);
          } else if (node.name.local == 'tbl') {
            parts.add(collapseWhitespace(_plainText(node)));
          }
        }
        final tcPr = childOf(tc, 'w:tcPr');
        final gridSpan = tcPr == null ? null : childOf(tcPr, 'w:gridSpan');
        final span = gridSpan == null ? 1 : (int.tryParse(attrOf(gridSpan, 'w:val') ?? '1') ?? 1);
        cells.add(parts.join('<br>'));
        for (var i = 1; i < span; i++) {
          cells.add('');
        }
      }

      if (cells.isEmpty) continue;
      if (isHeader && rows.length == headerRows) headerRows++;
      rows.add(cells);
    }

    if (rows.isEmpty) return '';
    if (headerRows == 0 && rows.length > 1 && rows.first.every((c) => c.trim().isNotEmpty)) {
      headerRows = 1;
    }
    if (headerRows == 0) rows.insert(0, List<String>.filled(rows.first.length, ''));

    return renderTable(rows);
  }

  void appendNotes(MarkdownWriter writer) {
    if (_usedNotes.isEmpty) return;
    writer.rule();
    writer.push(_usedNotes.map((note) => '[^${note.key}]: ${note.value}').join('\n'));
  }
}

/// Merge like-formatted runs first so Word's run splitting does not leak `****`.
String _emitSegments(List<_Segment> segments) {
  final merged = <_Segment>[];
  for (final segment in segments) {
    if (segment.text.isEmpty) continue;
    if (merged.isNotEmpty && merged.last.sameFormat(segment)) {
      merged.last.text += segment.text;
    } else {
      merged.add(segment.copy());
    }
  }

  final buffer = StringBuffer();
  for (final segment in merged) {
    final text = segment.text.replaceAll('\t', '    ');
    if (text.trim().isEmpty) {
      buffer.write(text);
      continue;
    }

    final leading = RegExp(r'^\s*').firstMatch(text)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(text)!.group(0)!;
    var core = text.substring(leading.length, text.length - trailing.length);

    if (segment.code) core = '`${core.replaceAll('`', '')}`';
    if (segment.strike) core = '~~$core~~';
    if (segment.bold) core = '**$core**';
    if (segment.italic) core = '*$core*';
    if (segment.sup) core = '<sup>$core</sup>';
    if (segment.sub) core = '<sub>$core</sub>';
    if (segment.href != null) core = mdLink(core, segment.href!);

    buffer..write(leading)..write(core)..write(trailing);
  }
  return buffer.toString().replaceAll(RegExp(r'[ \t]+\n'), '\n');
}

String _stripInlineMarkup(String text) {
  return text
      .replaceAllMapped(RegExp(r'\\([\\`*_\[\]<>|])'), (m) => m[1]!)
      .replaceAll(RegExp(r'(\*\*|__|~~|`)'), '');
}

String? _parseHyperlinkField(String instruction) {
  final quoted = RegExp('HYPERLINK\\s+"([^"]+)"', caseSensitive: false).firstMatch(instruction);
  if (quoted != null) return quoted.group(1);
  final bare = RegExp(r'HYPERLINK\s+(\S+)', caseSensitive: false).firstMatch(instruction);
  return bare?.group(1);
}

String _symbolChar(XmlElement sym) {
  final code = attrOf(sym, 'w:char');
  if (code == null) return '';
  final value = int.tryParse(code, radix: 16);
  if (value == null) return '';
  // Symbol/Wingdings live in the private use area; map the common bullets.
  const mapped = {0xf0b7: '•', 0xf0a7: '▪', 0xf0d8: '➢', 0xf0fc: '✔'};
  return mapped[value] ?? String.fromCharCode(value & 0xff != 0 ? value : 0x2022);
}
