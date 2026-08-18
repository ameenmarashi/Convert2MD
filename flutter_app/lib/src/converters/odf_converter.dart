import 'package:xml/xml.dart';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/package_archive.dart';
import '../core/xml_query.dart';

/// OpenDocument (.odt / .ods / .odp) → Markdown.
/// Mirrors `web/src/converters/odf.ts`.
RawOutput convertOdf(SourceFile file, ConvertOptions options) {
  final archive = DocumentArchive.open(file.bytes);
  final contentXml = archive.readText('content.xml');
  if (contentXml == null) {
    throw const ConversionException('Not an OpenDocument file: content.xml is missing.');
  }

  final content = parseRoot(contentXml);
  if (content == null) {
    throw const ConversionException('The OpenDocument content could not be parsed.');
  }

  final reader = _OdfReader(archive, options);
  reader.loadStyles(content);
  final styles = parseRoot(archive.readText('styles.xml'));
  if (styles != null) reader.loadStyles(styles);

  final body = firstDescendantOf(content, 'office:body');
  if (body == null) throw const ConversionException('OpenDocument file has no body.');

  final writer = MarkdownWriter();
  final text = childOf(body, 'office:text');
  final spreadsheet = childOf(body, 'office:spreadsheet');
  final presentation = childOf(body, 'office:presentation');

  if (spreadsheet != null) {
    reader.renderSpreadsheet(spreadsheet, writer);
  } else if (presentation != null) {
    reader.renderPresentation(presentation, writer);
  } else {
    reader.renderTextBody(text ?? body, writer);
  }

  return RawOutput(
    markdown: writer.toString(),
    meta: _readMeta(archive),
    warnings: reader.warnings,
    imageCount: reader.imageCount,
  );
}

Map<String, String> _readMeta(DocumentArchive archive) {
  final meta = <String, String>{};
  final root = parseRoot(archive.readText('meta.xml'));
  if (root == null) return meta;

  String pick(String tag) {
    final element = firstDescendantOf(root, tag);
    return element == null ? '' : collapseWhitespace(element.innerText).trim();
  }

  final title = pick('dc:title');
  final author = pick('dc:creator').isNotEmpty ? pick('dc:creator') : pick('meta:initial-creator');
  final created = pick('meta:creation-date');
  final modified = pick('dc:date');
  if (title.isNotEmpty) meta['title'] = title;
  if (author.isNotEmpty) meta['author'] = author;
  if (created.isNotEmpty) meta['created'] = created;
  if (modified.isNotEmpty) meta['modified'] = modified;
  return meta;
}

class _TextStyle {
  const _TextStyle({
    this.bold = false,
    this.italic = false,
    this.strike = false,
    this.mono = false,
  });

  final bool bold;
  final bool italic;
  final bool strike;
  final bool mono;

  _TextStyle merge(_TextStyle other) => _TextStyle(
        bold: bold || other.bold,
        italic: italic || other.italic,
        strike: strike || other.strike,
        mono: mono || other.mono,
      );
}

const _TextStyle _emptyStyle = _TextStyle();

class _OdfReader {
  _OdfReader(this.archive, this.options);

  final DocumentArchive archive;
  final ConvertOptions options;

  final List<String> warnings = <String>[];
  int imageCount = 0;

  final Map<String, _TextStyle> _textStyles = <String, _TextStyle>{};
  final Map<String, Map<int, bool>> _listStyles = <String, Map<int, bool>>{};
  final Map<String, String> _styleParents = <String, String>{};

  void loadStyles(XmlElement root) {
    for (final style in descendantsOf(root, 'style:style')) {
      final name = attrOf(style, 'style:name');
      if (name == null) continue;
      final parent = attrOf(style, 'style:parent-style-name');
      if (parent != null) _styleParents[name] = parent;

      final props = childOf(style, 'style:text-properties');
      if (props == null) continue;
      final fontName = (attrOf(props, 'style:font-name') ?? '').toLowerCase();
      _textStyles[name] = _TextStyle(
        bold: (attrOf(props, 'fo:font-weight') ?? '') == 'bold',
        italic: (attrOf(props, 'fo:font-style') ?? '') == 'italic',
        strike: (attrOf(props, 'style:text-line-through-style') ?? 'none') != 'none',
        mono: fontName.contains('mono') || fontName.contains('courier'),
      );
    }

    for (final listStyle in descendantsOf(root, 'text:list-style')) {
      final name = attrOf(listStyle, 'style:name');
      if (name == null) continue;
      final ordered = <int, bool>{};
      for (final level in listStyle.children.whereType<XmlElement>()) {
        final lvl = int.tryParse(attrOf(level, 'text:level') ?? '1') ?? 1;
        if (level.name.local == 'list-level-style-number') {
          ordered[lvl - 1] = true;
        } else if (level.name.local == 'list-level-style-bullet' ||
            level.name.local == 'list-level-style-image') {
          ordered[lvl - 1] = false;
        }
      }
      _listStyles[name] = ordered;
    }
  }

  _TextStyle _styleFor(String? name) {
    if (name == null) return _emptyStyle;
    final own = _textStyles[name];
    final parentName = _styleParents[name];
    final parent = parentName == null ? _emptyStyle : _styleFor(parentName);
    return own == null ? parent : own.merge(parent);
  }

  void renderTextBody(XmlElement container, MarkdownWriter writer) {
    for (final node in container.children) {
      if (node is XmlElement) _renderBlock(node, writer, 0);
    }
  }

  void _renderBlock(XmlElement element, MarkdownWriter writer, int depth) {
    switch (element.name.local) {
      case 'h':
        final level = int.tryParse(attrOf(element, 'text:outline-level') ?? '1') ?? 1;
        writer.heading(level.clamp(1, 6), _renderInline(element));
      case 'p':
        final text = _renderInline(element).trim();
        if (text.isNotEmpty) writer.push(text);
      case 'list':
        writer.push(_renderList(element, depth));
      case 'table':
        writer.push(_renderTableElement(element));
      case 'soft-page-break':
        if (options.pageSeparators) writer.rule();
      default:
        for (final child in element.children) {
          if (child is XmlElement) _renderBlock(child, writer, depth);
        }
    }
  }

  String _renderList(XmlElement list, int depth) {
    final styleName = attrOf(list, 'text:style-name');
    final listStyle = styleName == null ? null : _listStyles[styleName];
    final ordered = listStyle?[depth] ?? false;
    final indent = '  ' * depth;

    final lines = <String>[];
    var counter = 0;

    for (final item in childrenOf(list, 'text:list-item')) {
      counter++;
      final bullet = ordered ? '$counter.' : options.bulletChar;
      final pad = ' ' * (bullet.length + 1);
      final parts = <String>[];
      final nested = <String>[];

      for (final node in item.children) {
        if (node is! XmlElement) continue;
        if (node.name.local == 'list') {
          nested.add(_renderList(node, depth + 1));
        } else if (node.name.local == 'p' || node.name.local == 'h') {
          final text = _renderInline(node).trim();
          if (text.isNotEmpty) parts.add(text);
        }
      }

      if (parts.isEmpty && nested.isEmpty) continue;
      final body = parts.isEmpty ? '' : parts.first;
      lines.add('$indent$bullet $body'.replaceFirst(RegExp(r'\s+$'), ''));
      for (final extra in parts.skip(1)) {
        lines.add(extra.split('\n').map((l) => '$indent$pad$l').join('\n'));
      }
      lines.addAll(nested.where((n) => n.trim().isNotEmpty));
    }
    return lines.join('\n');
  }

  String _renderTableElement(XmlElement table) {
    final rows = <List<String>>[];
    var headerRows = 0;

    void pushRow(XmlElement row, {required bool header}) {
      final cells = <String>[];
      for (final cell in childrenOf(row, 'table:table-cell')) {
        final repeat =
            (int.tryParse(attrOf(cell, 'table:number-columns-repeated') ?? '1') ?? 1).clamp(1, 64);
        final text = _cellText(cell);
        for (var i = 0; i < repeat; i++) {
          cells.add(text);
        }
      }
      if (cells.isEmpty) return;
      if (header && rows.length == headerRows) headerRows++;
      rows.add(cells);
    }

    for (final node in table.children) {
      if (node is! XmlElement) continue;
      if (node.name.local == 'table-header-rows') {
        for (final row in childrenOf(node, 'table:table-row')) {
          pushRow(row, header: true);
        }
      } else if (node.name.local == 'table-row') {
        final repeat =
            (int.tryParse(attrOf(node, 'table:number-rows-repeated') ?? '1') ?? 1).clamp(1, 64);
        for (var i = 0; i < repeat; i++) {
          pushRow(node, header: false);
        }
      } else if (node.name.local == 'table-row-group' || node.name.local == 'table-rows') {
        for (final row in childrenOf(node, 'table:table-row')) {
          pushRow(row, header: false);
        }
      }
    }

    while (rows.isNotEmpty && rows.last.every((c) => c.trim().isEmpty)) {
      rows.removeLast();
    }
    if (rows.isEmpty) return '';

    var width = rows.fold<int>(0, (max, row) => row.length > max ? row.length : max);
    while (width > 0 &&
        rows.every((row) => (width - 1 < row.length ? row[width - 1] : '').trim().isEmpty)) {
      width--;
    }

    final trimmed = rows.map((row) {
      final copy = row.length > width ? row.sublist(0, width) : List<String>.from(row);
      while (copy.length < width) {
        copy.add('');
      }
      return copy;
    }).toList();

    if (headerRows == 0) trimmed.insert(0, List<String>.filled(width, ''));
    return renderTable(trimmed);
  }

  String _cellText(XmlElement cell) {
    final parts = <String>[];
    for (final node in cell.children) {
      if (node is! XmlElement) continue;
      if (node.name.local == 'p' || node.name.local == 'h') {
        final text = _renderInline(node).trim();
        if (text.isNotEmpty) parts.add(text);
      } else if (node.name.local == 'list') {
        parts.add(_renderList(node, 0).replaceAll('\n', '<br>'));
      }
    }
    if (parts.isEmpty) {
      return attrOf(cell, 'office:value') ?? attrOf(cell, 'office:date-value') ?? '';
    }
    return parts.join('<br>');
  }

  void renderSpreadsheet(XmlElement body, MarkdownWriter writer) {
    final tables = childrenOf(body, 'table:table');
    for (final table in tables) {
      if (tables.length > 1) writer.heading(2, attrOf(table, 'table:name') ?? 'Sheet');
      final rendered = _renderTableElement(table);
      if (rendered.isNotEmpty) {
        writer.push(rendered);
      } else {
        writer.paragraph('_Empty sheet._');
      }
    }
  }

  void renderPresentation(XmlElement body, MarkdownWriter writer) {
    final pages = childrenOf(body, 'draw:page');
    for (var index = 0; index < pages.length; index++) {
      final page = pages[index];
      if (index > 0 && options.pageSeparators) writer.rule();
      writer.heading(2, attrOf(page, 'draw:name') ?? 'Slide ${index + 1}');

      for (final frame in descendantsOf(page, 'draw:frame')) {
        final image = childOf(frame, 'draw:image');
        if (image != null) {
          final markdown = _renderImageElement(image, attrOf(frame, 'draw:name') ?? '');
          if (markdown.isNotEmpty) writer.push(markdown);
          continue;
        }
        final lines = <String>[];
        for (final para in descendantsOf(frame, 'text:p')) {
          final text = _renderInline(para).trim();
          if (text.isNotEmpty) lines.add('${options.bulletChar} $text');
        }
        if (lines.isNotEmpty) writer.push(lines.join('\n'));
      }

      final notes = childOf(page, 'presentation:notes');
      if (notes != null && options.includeNotes) {
        final text = descendantsOf(notes, 'text:p')
            .map((p) => _renderInline(p).trim())
            .where((t) => t.isNotEmpty)
            .join(' ');
        if (text.isNotEmpty) writer.quote('**Speaker notes:** $text');
      }
    }
  }

  String _renderInline(XmlElement element, [_TextStyle? inherited]) {
    final style = inherited ?? _styleFor(attrOf(element, 'text:style-name'));
    final buffer = StringBuffer();
    for (final node in element.children) {
      buffer.write(_renderInlineNode(node, style));
    }
    return buffer.toString();
  }

  String _renderInlineNode(XmlNode node, _TextStyle style) {
    if (node is XmlText) return _applyStyle(escapeInline(node.value), style);
    if (node is! XmlElement) return '';

    switch (node.name.local) {
      case 's':
        final count = int.tryParse(attrOf(node, 'text:c') ?? '1') ?? 1;
        return ' ' * (count > 8 ? 8 : count);
      case 'tab':
        return '    ';
      case 'line-break':
        return '  \n';
      case 'a':
        final href = attrOf(node, 'xlink:href') ?? '';
        final inner = _renderInline(node, style).trim();
        return href.isEmpty ? inner : mdLink(inner.isEmpty ? href : inner, href);
      case 'span':
        return _renderInline(node, style.merge(_styleFor(attrOf(node, 'text:style-name'))));
      case 'image':
        return _renderImageElement(node, '');
      case 'frame':
        final image = childOf(node, 'draw:image');
        if (image != null) return _renderImageElement(image, attrOf(node, 'draw:name') ?? '');
        return _renderInline(node, style);
      case 'note':
        if (!options.includeNotes) return '';
        final body = firstDescendantOf(node, 'text:note-body');
        final text = body == null ? '' : collapseWhitespace(body.innerText).trim();
        return text.isEmpty ? '' : ' ^[$text]';
      case 'bookmark':
      case 'bookmark-start':
      case 'bookmark-end':
      case 'sequence-decls':
      case 'annotation':
        return '';
      default:
        return _renderInline(node, style);
    }
  }

  String _renderImageElement(XmlElement image, String alt) {
    if (options.imageMode == ImageMode.skip) return '';
    final href = attrOf(image, 'xlink:href');
    if (href == null || href.isEmpty) return '';

    if (RegExp(r'^https?:', caseSensitive: false).hasMatch(href)) {
      imageCount++;
      return mdImage(alt.isEmpty ? 'image' : alt, href);
    }

    final path = href.replaceFirst(RegExp(r'^\./'), '');
    if (options.imageMode == ImageMode.reference) {
      imageCount++;
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
    imageCount++;
    return mdImage(alt.isEmpty ? basenameOf(path) : alt, dataUri(bytes, imageMimeFor(path)));
  }

  String _applyStyle(String text, _TextStyle style) {
    if (text.trim().isEmpty) return text;
    final leading = RegExp(r'^\s*').firstMatch(text)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(text)!.group(0)!;
    var core = text.substring(leading.length, text.length - trailing.length);
    if (style.mono) core = '`${core.replaceAll('`', '')}`';
    if (style.strike) core = '~~$core~~';
    if (style.bold) core = '**$core**';
    if (style.italic) core = '*$core*';
    return '$leading$core$trailing';
  }
}
