import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html_parser;

import '../core/markdown.dart';

/// HTML → Markdown. Also backs EPUB chapters and the HTML part of emails,
/// so it takes a parsed tree and lets the caller rewrite URLs.
/// Mirrors `web/src/converters/html.ts`.
typedef UrlResolver = String? Function(String url, UrlKind kind);

enum UrlKind { image, link }

class HtmlOptions {
  const HtmlOptions({
    required this.bullet,
    this.resolveUrl,
    this.headingOffset = 0,
    this.onImage,
  });

  final String bullet;
  final UrlResolver? resolveUrl;
  final int headingOffset;
  final void Function()? onImage;
}

const Set<String> _skipped = {
  'script', 'style', 'noscript', 'head', 'meta', 'link', 'title', 'iframe', 'object', 'embed',
  'canvas', 'svg', 'template', 'button', 'input', 'select', 'textarea', 'form', 'nav',
};

const Set<String> _blockContainers = {
  'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure',
  'fieldset', 'details', 'summary', 'address', 'center', 'font', 'span',
};

const Set<String> _blockTags = {
  'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'dl', 'dt', 'dd', 'figcaption',
};

dom.Document parseHtmlDocument(String source) => html_parser.parse(source);

String htmlStringToMarkdown(String source, HtmlOptions options) {
  return htmlToMarkdown(html_parser.parse(source), options);
}

String htmlToMarkdown(dom.Document document, HtmlOptions options) {
  final converter = _HtmlConverter(options, _collectClassStyles(document));
  final body = document.body ?? document.documentElement;
  if (body == null) return '';
  return normalizeMarkdown(converter.renderChildren(body).join('\n\n'));
}

class _InlineStyle {
  const _InlineStyle({this.bold = false, this.italic = false, this.strike = false});

  final bool bold;
  final bool italic;
  final bool strike;

  bool get isEmpty => !bold && !italic && !strike;

  _InlineStyle merge(_InlineStyle other) => _InlineStyle(
        bold: bold || other.bold,
        italic: italic || other.italic,
        strike: strike || other.strike,
      );
}

final RegExp _boldRule = RegExp(r'font-weight\s*:\s*(bold(er)?|[6-9]00)');
final RegExp _italicRule = RegExp(r'font-style\s*:\s*(italic|oblique)');
final RegExp _strikeRule = RegExp(r'text-decoration[^;]*line-through');

/// Word and Google Docs export emphasis as CSS classes on bare `<span>`s rather
/// than `<b>`/`<i>`, so the stylesheet has to be read to keep it.
Map<String, _InlineStyle> _collectClassStyles(dom.Document document) {
  final styles = <String, _InlineStyle>{};

  for (final styleElement in document.querySelectorAll('style')) {
    final css = styleElement.text.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');

    for (final rule in RegExp(r'([^{}]+)\{([^{}]*)\}').allMatches(css)) {
      final body = rule.group(2)!.toLowerCase();
      final style = _InlineStyle(
        bold: _boldRule.hasMatch(body),
        italic: _italicRule.hasMatch(body),
        strike: _strikeRule.hasMatch(body),
      );
      if (style.isEmpty) continue;

      for (final selector in rule.group(1)!.split(',')) {
        final match = RegExp(r'^\.([\w-]+)$').firstMatch(selector.trim());
        if (match == null) continue;
        final name = match.group(1)!;
        styles[name] = (styles[name] ?? const _InlineStyle()).merge(style);
      }
    }
  }
  return styles;
}

String htmlTitle(dom.Document document) {
  final title = document.head?.querySelector('title')?.text.trim() ?? '';
  if (title.isNotEmpty) return collapseWhitespace(title).trim();

  for (final meta in document.querySelectorAll('meta')) {
    final name = (meta.attributes['name'] ?? meta.attributes['property'] ?? '').toLowerCase();
    if (name == 'og:title' || name == 'title') {
      final content = meta.attributes['content']?.trim() ?? '';
      if (content.isNotEmpty) return content;
    }
  }
  final h1 = document.querySelector('h1');
  return h1 == null ? '' : collapseWhitespace(h1.text).trim();
}

Map<String, String> htmlMeta(dom.Document document) {
  final meta = <String, String>{};
  for (final element in document.querySelectorAll('meta')) {
    final key = (element.attributes['name'] ?? element.attributes['property'] ?? '').toLowerCase();
    final content = element.attributes['content']?.trim() ?? '';
    if (key.isEmpty || content.isEmpty) continue;
    if (key == 'author' || key == 'article:author') meta['author'] = content;
    if (key == 'description' || key == 'og:description') meta['description'] = content;
    if (key == 'keywords') meta['keywords'] = content;
    if (key == 'article:published_time' || key == 'date') meta['date'] = content;
  }
  return meta;
}

class _HtmlConverter {
  _HtmlConverter(this.options, this._classStyles);

  final HtmlOptions options;
  final Map<String, _InlineStyle> _classStyles;
  final List<_ListState> _listStack = <_ListState>[];

  List<String> renderChildren(dom.Element element) {
    final blocks = <String>[];
    var inlineRun = <dom.Node>[];

    void flush() {
      if (inlineRun.isEmpty) return;
      final text = _trimInline(inlineRun.map(_renderInline).join());
      if (text.isNotEmpty) blocks.add(text);
      inlineRun = <dom.Node>[];
    }

    for (final node in element.nodes) {
      if (node is dom.Text) {
        inlineRun.add(node);
        continue;
      }
      if (node is! dom.Element) continue;
      if (_skipped.contains(node.localName)) continue;

      if (_isBlock(node)) {
        flush();
        blocks.addAll(_renderBlock(node));
      } else {
        inlineRun.add(node);
      }
    }
    flush();
    return blocks.where((block) => block.trim().isNotEmpty).toList();
  }

  bool _isBlock(dom.Element element) {
    final tag = element.localName ?? '';
    if (tag == 'span' || tag == 'font') {
      return element.nodes.any((n) => n is dom.Element && n.localName != 'span' && _isBlock(n));
    }
    return _blockContainers.contains(tag) ||
        RegExp(r'^h[1-6]$').hasMatch(tag) ||
        _blockTags.contains(tag);
  }

  List<String> _renderBlock(dom.Element element) {
    final tag = element.localName ?? '';

    if (RegExp(r'^h[1-6]$').hasMatch(tag)) {
      final level = (int.parse(tag[1]) + options.headingOffset).clamp(1, 6);
      final text = _trimInline(_renderInlineChildren(element));
      return text.isEmpty ? const [] : ['${'#' * level} ${text.replaceAll(RegExp(r'\n+'), ' ')}'];
    }

    switch (tag) {
      case 'p':
      case 'figcaption':
      case 'dt':
      case 'dd':
        final text = _trimInline(_renderInlineChildren(element));
        if (text.isEmpty) return const [];
        if (tag == 'dt') return ['**$text**'];
        if (tag == 'dd') return [': $text'];
        return [escapeLeadingMarker(text)];
      case 'hr':
        return ['---'];
      case 'pre':
        return [_renderPre(element)];
      case 'blockquote':
        final inner = renderChildren(element).join('\n\n');
        if (inner.trim().isEmpty) return const [];
        return [inner.split('\n').map((l) => l.isEmpty ? '>' : '> $l').join('\n')];
      case 'ul':
      case 'ol':
        return [_renderList(element)];
      case 'table':
        return _renderTable(element);
      case 'dl':
        return renderChildren(element);
      default:
        return renderChildren(element);
    }
  }

  String _renderPre(dom.Element element) {
    final code = element.querySelector('code') ?? element;
    final classes = (code.attributes['class'] ?? '').split(RegExp(r'\s+'));
    final langClass = classes.firstWhere(
      (c) => RegExp(r'^(language|lang|highlight)-').hasMatch(c),
      orElse: () => '',
    );
    final language = langClass.replaceFirst(RegExp(r'^(language|lang|highlight)-'), '');
    final text = _rawText(code).replaceFirst(RegExp(r'^\n'), '').replaceFirst(RegExp(r'\s+$'), '');
    return codeBlock(text, language);
  }

  String _rawText(dom.Node node) {
    if (node is dom.Text) return node.text;
    if (node is dom.Element) {
      if (node.localName == 'br') return '\n';
      return node.nodes.map(_rawText).join();
    }
    return '';
  }

  String _renderList(dom.Element element) {
    final ordered = element.localName == 'ol';
    final start = int.tryParse(element.attributes['start'] ?? '1') ?? 1;
    _listStack.add(_ListState(ordered: ordered, index: start));

    final lines = <String>[];
    final depth = _listStack.length - 1;
    final indent = '  ' * depth;

    for (final li in element.children) {
      if (li.localName != 'li') continue;

      final state = _listStack.last;
      final marker = ordered ? '${state.index++}.' : options.bullet;
      final checkbox = _taskMarker(li);

      final split = _splitListItem(li);
      final body = split.blocks.join('\n\n').trim();
      if (body.isEmpty && split.nested.isEmpty && checkbox.isEmpty) continue;

      final pad = ' ' * (marker.length + 1);
      final rendered = body
          .split('\n')
          .asMap()
          .entries
          .map((entry) => entry.key == 0
              ? entry.value
              : (entry.value.isEmpty ? '' : '$indent$pad${entry.value}'))
          .join('\n');

      // Nested lists carry their own indent and must not be separated by a
      // blank line, or the outer list breaks into two.
      final suffix = split.nested.isEmpty ? '' : '\n${split.nested.join('\n')}';
      lines.add('$indent$marker $checkbox$rendered$suffix'.replaceFirst(RegExp(r'[ \t]+$'), ''));
    }

    _listStack.removeLast();
    return lines.join('\n');
  }

  _ListItemParts _splitListItem(dom.Element li) {
    final blocks = <String>[];
    final nested = <String>[];
    var inlineRun = <dom.Node>[];

    void flush() {
      if (inlineRun.isEmpty) return;
      final text = _trimInline(inlineRun.map(_renderInline).join());
      if (text.isNotEmpty) blocks.add(text);
      inlineRun = <dom.Node>[];
    }

    for (final node in li.nodes) {
      if (node is dom.Text) {
        inlineRun.add(node);
        continue;
      }
      if (node is! dom.Element) continue;
      if (_skipped.contains(node.localName)) continue;

      if (node.localName == 'ul' || node.localName == 'ol') {
        flush();
        final rendered = _renderList(node);
        if (rendered.trim().isNotEmpty) nested.add(rendered);
      } else if (_isBlock(node)) {
        flush();
        blocks.addAll(_renderBlock(node));
      } else {
        inlineRun.add(node);
      }
    }
    flush();
    return _ListItemParts(blocks, nested);
  }

  String _taskMarker(dom.Element li) {
    final input = li.querySelector('input');
    if (input == null) return '';
    if ((input.attributes['type'] ?? '').toLowerCase() != 'checkbox') return '';
    return input.attributes.containsKey('checked') ? '[x] ' : '[ ] ';
  }

  List<String> _renderTable(dom.Element element) {
    final rows = <List<String>>[];
    var headerRows = 0;

    for (final tr in element.querySelectorAll('tr')) {
      final cells = <String>[];
      var isHeaderRow = true;
      for (final cell in tr.children) {
        final tag = cell.localName;
        if (tag != 'td' && tag != 'th') continue;
        if (tag != 'th') isHeaderRow = false;
        final text = _trimInline(renderChildren(cell).join('<br>'));
        final span = int.tryParse(cell.attributes['colspan'] ?? '1') ?? 1;
        cells.add(text);
        for (var i = 1; i < span; i++) {
          cells.add('');
        }
      }
      if (cells.isEmpty) continue;
      if (isHeaderRow && rows.length == headerRows) headerRows++;
      rows.add(cells);
    }

    if (rows.isEmpty) return const [];
    if (headerRows == 0) rows.insert(0, List<String>.filled(rows.first.length, ''));

    final out = <String>[renderTable(rows)];
    final caption = element.querySelector('caption');
    if (caption != null) {
      final text = _trimInline(_renderInlineChildren(caption));
      if (text.isNotEmpty) out.insert(0, '**$text**');
    }
    return out;
  }

  String _renderInlineChildren(dom.Element element) => element.nodes.map(_renderInline).join();

  String _renderInline(dom.Node node) {
    if (node is dom.Text) {
      return escapeInline(collapseWhitespace(node.text.replaceAll('\n', ' ')));
    }
    if (node is! dom.Element) return '';

    final tag = node.localName ?? '';
    if (_skipped.contains(tag)) return '';

    switch (tag) {
      case 'br':
        return '  \n';
      case 'img':
        return _renderImage(node);
      case 'a':
        return _renderAnchor(node);
      case 'strong':
      case 'b':
        return _wrap(_renderInlineChildren(node), '**');
      case 'em':
      case 'i':
      case 'cite':
      case 'var':
        return _wrap(_renderInlineChildren(node), '*');
      case 'del':
      case 's':
      case 'strike':
        return _wrap(_renderInlineChildren(node), '~~');
      case 'mark':
        return _wrap(_renderInlineChildren(node), '==');
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return _inlineCode(_rawText(node));
      case 'sup':
        return _wrapTag(_renderInlineChildren(node), 'sup');
      case 'sub':
        return _wrapTag(_renderInlineChildren(node), 'sub');
      case 'q':
        return '"${_renderInlineChildren(node)}"';
      case 'wbr':
        return '';
      default:
        if (_isBlock(node)) return _renderBlock(node).join('\n\n');
        final inner = _renderInlineChildren(node);
        final style = _styleForElement(node);
        return style == null ? inner : _applyStyle(inner, style);
    }
  }

  _InlineStyle? _styleForElement(dom.Element element) {
    final classes = (element.attributes['class'] ?? '').split(RegExp(r'\s+'));
    final inline = (element.attributes['style'] ?? '').toLowerCase();

    var style = _InlineStyle(
      bold: _boldRule.hasMatch(inline),
      italic: _italicRule.hasMatch(inline),
      strike: _strikeRule.hasMatch(inline),
    );
    for (final name in classes) {
      final classStyle = _classStyles[name];
      if (classStyle != null) style = style.merge(classStyle);
    }
    return style.isEmpty ? null : style;
  }

  String _applyStyle(String text, _InlineStyle style) {
    var out = text;
    if (style.strike) out = _wrap(out, '~~');
    if (style.bold) out = _wrap(out, '**');
    if (style.italic) out = _wrap(out, '*');
    return out;
  }

  String _renderAnchor(dom.Element element) {
    final inner = _renderInlineChildren(element);
    final raw = element.attributes['href'];
    if (raw == null || raw.isEmpty) return inner;

    final href = options.resolveUrl == null ? raw : options.resolveUrl!(raw, UrlKind.link);
    if (href == null || href.isEmpty) return inner;
    if (inner.trim().isEmpty) return href.startsWith('#') ? '' : '<$href>';

    final leading = RegExp(r'^\s*').firstMatch(inner)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(inner)!.group(0)!;
    return '$leading${mdLink(inner.trim(), href, element.attributes['title'])}$trailing';
  }

  String _renderImage(dom.Element element) {
    final raw = element.attributes['src'] ?? element.attributes['data-src'] ?? '';
    if (raw.isEmpty) return '';
    final src = options.resolveUrl == null ? raw : options.resolveUrl!(raw, UrlKind.image);
    if (src == null || src.isEmpty) return '';
    options.onImage?.call();
    return mdImage((element.attributes['alt'] ?? '').trim(), src, element.attributes['title']);
  }

  String _inlineCode(String text) {
    final clean = text.replaceAll(RegExp(r'\r?\n'), ' ');
    if (clean.trim().isEmpty) return '';
    var longest = 0;
    for (final match in RegExp('`+').allMatches(clean)) {
      if (match.group(0)!.length > longest) longest = match.group(0)!.length;
    }
    final fence = '`' * (longest + 1);
    final pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
    return '$fence$pad$clean$pad$fence';
  }

  /// Keep whitespace outside emphasis markers — `** bold **` does not render.
  String _wrap(String inner, String marker) {
    if (inner.trim().isEmpty) return inner;
    final leading = RegExp(r'^\s*').firstMatch(inner)!.group(0)!;
    final trailing = RegExp(r'\s*$').firstMatch(inner)!.group(0)!;
    final core = inner.substring(leading.length, inner.length - trailing.length);
    if (core.startsWith(marker) && core.endsWith(marker)) return inner;
    return '$leading$marker$core$marker$trailing';
  }

  String _wrapTag(String inner, String tag) =>
      inner.trim().isEmpty ? '' : '<$tag>${inner.trim()}</$tag>';

  String _trimInline(String text) => text.trim();
}

class _ListState {
  _ListState({required this.ordered, required this.index});

  final bool ordered;
  int index;
}

class _ListItemParts {
  const _ListItemParts(this.blocks, this.nested);

  final List<String> blocks;
  final List<String> nested;
}
