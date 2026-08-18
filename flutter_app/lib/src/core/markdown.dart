import 'dart:convert';
import 'dart:typed_data';

/// Markdown emission helpers shared by every converter.
/// Mirrors `web/src/core/md.ts`.

final RegExp _inlineEscape = RegExp(r'([\\`*_\[\]<>|])');
final RegExp _lineLeading = RegExp(r'^(\s*)([-+*>#]|\d+[.)])(\s)');

String escapeInline(String text) => text.replaceAllMapped(_inlineEscape, (m) => '\\${m[1]}');

String escapeBlock(String text) {
  return escapeInline(text).replaceFirstMapped(_lineLeading, (m) => '${m[1]}\\${m[2]}${m[3]}');
}

/// The text is already Markdown; only a marker at the very start needs escaping.
String escapeLeadingMarker(String text) {
  return text.replaceFirstMapped(
    RegExp(r'^(\s*)([-+>#]|\d+[.)])(\s)'),
    (m) => '${m[1]}\\${m[2]}${m[3]}',
  );
}

String escapeTableCell(String text) =>
    escapeInline(text).replaceAll(RegExp(r'\r?\n'), '<br>');

String collapseWhitespace(String text) => text
    .replaceAll(RegExp(r'[\t\f\v ]+'), ' ')
    .replaceAll(RegExp(r' {2,}'), ' ');

String mdLink(String text, String href, [String? title]) {
  final safeHref = _encodeHref(href);
  final label = text.trim().isEmpty ? safeHref : text.trim();
  final suffix = title == null || title.isEmpty ? '' : ' "${title.replaceAll('"', r'\"')}"';
  return '[$label]($safeHref$suffix)';
}

String mdImage(String alt, String href, [String? title]) {
  final suffix = title == null || title.isEmpty ? '' : ' "${title.replaceAll('"', r'\"')}"';
  return '![${alt.replaceAll(RegExp(r'[\[\]]'), '')}](${_encodeHref(href)}$suffix)';
}

String _encodeHref(String href) {
  final trimmed = href.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  if (RegExp(r'[ ()<>]').hasMatch(trimmed)) return '<${trimmed.replaceAll('>', '%3E')}>';
  return trimmed;
}

enum ColumnAlign { left, center, right }

String renderTable(List<List<String>> rows, {List<ColumnAlign?> align = const []}) {
  if (rows.isEmpty) return '';

  final width = rows.fold<int>(0, (max, row) => row.length > max ? row.length : max);
  final padded = rows.map((row) {
    final copy = List<String>.from(row);
    while (copy.length < width) {
      copy.add('');
    }
    return copy.map((cell) => escapeTableCell(cell).trim()).toList();
  }).toList();

  final widths = List<int>.filled(width, 3);
  for (final row in padded) {
    for (var c = 0; c < width; c++) {
      final length = row[c].runes.length;
      if (length > widths[c]) widths[c] = length;
    }
  }

  String line(List<String> cells) {
    final buffer = <String>[];
    for (var c = 0; c < width; c++) {
      buffer.add(_padEnd(cells[c], widths[c]));
    }
    return '| ${buffer.join(' | ')} |';
  }

  final divider = <String>[];
  for (var c = 0; c < width; c++) {
    final alignment = c < align.length ? align[c] : null;
    final w = widths[c];
    divider.add(switch (alignment) {
      ColumnAlign.center => ':${'-' * (w - 2 < 1 ? 1 : w - 2)}:',
      ColumnAlign.right => '${'-' * (w - 1 < 2 ? 2 : w - 1)}:',
      ColumnAlign.left => ':${'-' * (w - 1 < 2 ? 2 : w - 1)}',
      null => '-' * w,
    });
  }

  return <String>[
    line(padded.first),
    '| ${divider.join(' | ')} |',
    ...padded.skip(1).map(line),
  ].join('\n');
}

String _padEnd(String value, int width) {
  final length = value.runes.length;
  return length >= width ? value : value + ' ' * (width - length);
}

const Map<String, String> _fenceLanguages = {
  'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'rb': 'ruby', 'sh': 'bash',
  'yml': 'yaml', 'md': 'markdown', 'kt': 'kotlin', 'rs': 'rust', 'cs': 'csharp',
  'cpp': 'cpp', 'h': 'c', 'm': 'objectivec',
};

String fenceLanguage(String extension) {
  final ext = extension.replaceFirst(RegExp(r'^\.'), '').toLowerCase();
  return _fenceLanguages[ext] ?? ext;
}

String codeBlock(String code, [String language = '']) {
  var longest = 0;
  for (final match in RegExp('`{3,}').allMatches(code)) {
    if (match.group(0)!.length > longest) longest = match.group(0)!.length;
  }
  final fence = '`' * (longest + 1 > 3 ? longest + 1 : 3);
  return '$fence$language\n${code.replaceFirst(RegExp(r'\n+$'), '')}\n$fence';
}

String yamlFrontMatter(Map<String, String> meta) {
  final entries = meta.entries.where((entry) => entry.value.isNotEmpty).toList();
  if (entries.isEmpty) return '';
  final lines = entries.map((entry) => '${entry.key}: ${_yamlScalar(entry.value)}');
  return <String>['---', ...lines, '---'].join('\n');
}

String _yamlScalar(String value) {
  final needsQuotes = RegExp(r'''^[\s>|@`&*!%#{\[\]}]|[:#]\s|["'\\]|^$''').hasMatch(value) ||
      RegExp(r'^(true|false|null|yes|no|on|off|~)$', caseSensitive: false).hasMatch(value) ||
      RegExp(r'^-?\d+(\.\d+)?$').hasMatch(value) ||
      value.contains('\n');
  if (!needsQuotes) return value;
  final escaped = value.replaceAll('\\', r'\\').replaceAll('"', r'\"').replaceAll('\n', r'\n');
  return '"$escaped"';
}

/// Normalise newlines, drop trailing spaces that are not a hard break, and
/// collapse runs of blank lines.
String normalizeMarkdown(String markdown) {
  var out = markdown.replaceAll(RegExp(r'\r\n?'), '\n');
  out = out.replaceAllMapped(
    RegExp(r'[ \t]+$', multiLine: true),
    (m) => m[0] == '  ' ? '  ' : '',
  );
  out = out.replaceAll(RegExp(r'\n{3,}'), '\n\n');
  out = out.replaceFirst(RegExp(r'^\n+'), '');
  out = out.replaceFirst(RegExp(r'\s+$'), '');
  return '$out\n';
}

/// Assembles blocks with exactly one blank line between them.
class MarkdownWriter {
  final List<String> _blocks = <String>[];

  bool get isEmpty => _blocks.isEmpty;

  void push(String block) {
    final trimmed = block.replaceFirst(RegExp(r'\s+$'), '');
    if (trimmed.trim().isEmpty) return;
    _blocks.add(trimmed);
  }

  void heading(int level, String text) {
    final clean = collapseWhitespace(text).trim();
    if (clean.isEmpty) return;
    final depth = level.clamp(1, 6);
    push('${'#' * depth} $clean');
  }

  void paragraph(String text) => push(text.trim());

  void code(String text, [String language = '']) {
    if (text.trim().isEmpty) return;
    push(codeBlock(text, language));
  }

  void quote(String text) {
    final body = text.trim();
    if (body.isEmpty) return;
    push(body.split('\n').map((line) => line.isEmpty ? '>' : '> $line').join('\n'));
  }

  void rule() => _blocks.add('---');

  void table(List<List<String>> rows, {List<ColumnAlign?> align = const []}) {
    push(renderTable(rows, align: align));
  }

  @override
  String toString() => normalizeMarkdown(_blocks.join('\n\n'));
}

const Map<String, String> _imageMime = {
  'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
  'bmp': 'image/bmp', 'svg': 'image/svg+xml', 'webp': 'image/webp', 'tif': 'image/tiff',
  'tiff': 'image/tiff', 'emf': 'image/emf', 'wmf': 'image/wmf', 'heic': 'image/heic',
  'avif': 'image/avif', 'ico': 'image/x-icon',
};

String imageMimeFor(String name) {
  final ext = name.split('.').last.toLowerCase();
  return _imageMime[ext] ?? 'application/octet-stream';
}

String dataUri(Uint8List bytes, String mime) => 'data:$mime;base64,${base64Encode(bytes)}';

String basenameOf(String path) => path.split('/').last;

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

int countWords(String markdown) {
  final text = markdown
      .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
      .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), ' ')
      .replaceAll(RegExp(r'[#>*_`|-]'), ' ');
  return RegExp(r"[\p{L}\p{N}][\p{L}\p{N}'’-]*", unicode: true).allMatches(text).length;
}

/// Resolve a relative part reference inside a package, e.g. `word` + `media/a.png`.
String normalizePart(String baseDir, String target) {
  if (target.startsWith('/')) return target.substring(1);
  final segments = '$baseDir/$target'.split('/');
  final out = <String>[];
  for (final segment in segments) {
    if (segment == '.' || segment.isEmpty) continue;
    if (segment == '..') {
      if (out.isNotEmpty) out.removeLast();
    } else {
      out.add(segment);
    }
  }
  return out.join('/');
}
