import 'dart:math' as math;

import '../../core/markdown.dart';
import 'content.dart';

/// Turns positioned text runs into Markdown by inferring the structure PDF
/// does not carry. Mirrors `web/src/converters/pdf/layout.ts`.
class Line {
  Line({
    required this.y,
    required this.x,
    required this.endX,
    required this.size,
    required this.bold,
    required this.italic,
    required this.text,
  });

  final double y;
  final double x;
  final double endX;
  final double size;
  final bool bold;
  final bool italic;
  final String text;
}

class PdfLayoutOptions {
  const PdfLayoutOptions({required this.bullet, required this.detectHeadings});

  final String bullet;
  final bool detectHeadings;
}

List<Line> buildLines(List<TextItem> items) {
  if (items.isEmpty) return const [];

  final sorted = List<TextItem>.from(items)
    ..sort((a, b) => (a.y - b.y).abs() > 0.6 ? b.y.compareTo(a.y) : a.x.compareTo(b.x));

  final lines = <Line>[];
  var current = <TextItem>[];
  var currentY = sorted.first.y;
  var currentSize = sorted.first.size;

  void flush() {
    if (current.isEmpty) return;
    final line = _mergeLine(current);
    if (line.text.trim().isNotEmpty) lines.add(line);
    current = <TextItem>[];
  }

  for (final item in sorted) {
    final tolerance = math.max(1.2, math.min(currentSize, item.size) * 0.45);
    if (current.isNotEmpty && (item.y - currentY).abs() > tolerance) {
      flush();
      currentY = item.y;
      currentSize = item.size;
    }
    current.add(item);
    currentY = current.fold<double>(0, (sum, it) => sum + it.y) / current.length;
    currentSize = math.max(currentSize, item.size);
  }
  flush();

  lines.sort((a, b) => b.y.compareTo(a.y));
  return lines;
}

Line _mergeLine(List<TextItem> items) {
  final ordered = List<TextItem>.from(items)..sort((a, b) => a.x.compareTo(b.x));
  final buffer = StringBuffer();
  var endX = ordered.first.x;
  var bold = true;
  var italic = true;
  var size = 0.0;
  var weight = 0.0;

  for (final item in ordered) {
    final gap = item.x - endX;
    final reference = math.max(item.size, size == 0 ? item.size : size);
    final text = buffer.toString();
    if (text.isNotEmpty && gap > reference * 0.22 && !text.endsWith(' ') && !item.text.startsWith(' ')) {
      buffer.write(' ');
    }
    buffer.write(item.text);
    endX = math.max(endX, item.x + item.width);

    final length = math.max(1, item.text.trim().length).toDouble();
    size += item.size * length;
    weight += length;
    if (!item.bold) bold = false;
    if (!item.italic) italic = false;
  }

  return Line(
    y: ordered.fold<double>(0, (sum, it) => sum + it.y) / ordered.length,
    x: ordered.first.x,
    endX: endX,
    size: weight > 0 ? size / weight : ordered.first.size,
    bold: bold,
    italic: italic,
    text: buffer.toString().replaceAll(RegExp(r'\s+'), ' ').trim(),
  );
}

/// Text that appears at the same height on most pages is chrome, not content.
void stripRunningHeadersAndFooters(List<List<Line>> pages) {
  if (pages.length < 3) return;

  final counts = <String, int>{};
  final candidates = pages.map((lines) {
    final edge = <Line>[
      ...lines.take(2),
      ...lines.skip(lines.length > 2 ? lines.length - 2 : 0),
    ];
    return edge.map(_fingerprint).toSet();
  }).toList();

  for (final set in candidates) {
    for (final key in set) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  final threshold = math.max(3, (pages.length * 0.6).ceil());
  final repeated = counts.entries.where((e) => e.value >= threshold).map((e) => e.key).toSet();
  if (repeated.isEmpty) return;

  for (var index = 0; index < pages.length; index++) {
    final lines = pages[index];
    pages[index] = <Line>[
      for (var position = 0; position < lines.length; position++)
        if (!((position < 2 || position >= lines.length - 2) && repeated.contains(_fingerprint(lines[position]))))
          lines[position],
    ];
  }
}

String _fingerprint(Line line) {
  final text = line.text.replaceAll(RegExp(r'\d+'), '#').toLowerCase();
  return '${(line.y / 6).round()}|${text.length > 60 ? text.substring(0, 60) : text}';
}

final RegExp _bulletPattern = RegExp(r'^([•·▪◦‣∙○●■□*–—-])\s+(.*)$');
final RegExp _orderedPattern = RegExp(r'^(\d{1,3})[.)]\s+(.*)$');
final RegExp _letterPattern = RegExp(r'^([a-zA-Z])[.)]\s+(.*)$');

enum _BlockKind { paragraph, heading, list }

class _Block {
  _Block({
    required this.kind,
    required this.level,
    required this.size,
    required this.lines,
    this.ordered = false,
    this.marker = '',
    this.indent = 0,
  });

  final _BlockKind kind;
  final int level;
  final double size;
  final List<Line> lines;
  final bool ordered;
  final String marker;
  final int indent;
}

String pageToMarkdown(
  List<Line> lines,
  PdfLayoutOptions options,
  double bodySize,
  List<double> sizeLevels,
) {
  if (lines.isEmpty) return '';

  final gaps = <double>[];
  for (var i = 1; i < lines.length; i++) {
    gaps.add(lines[i - 1].y - lines[i].y);
  }
  final medianGap = _median(gaps.where((g) => g > 0).toList());
  final effectiveGap = medianGap == 0 ? bodySize * 1.2 : medianGap;
  final leftEdge = lines.map((l) => l.x).reduce(math.min);

  final blocks = <_Block>[];

  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final previous = i > 0 ? lines[i - 1] : null;
    final gap = previous == null ? double.infinity : previous.y - line.y;

    final listMatch = _matchListItem(line.text);
    final headingLevel = options.detectHeadings ? _headingLevelFor(line, bodySize, sizeLevels) : 0;

    final startsBlock = previous == null ||
        gap > effectiveGap * 1.45 ||
        (line.size - previous.size).abs() > math.max(0.8, bodySize * 0.12) ||
        listMatch != null ||
        headingLevel > 0 ||
        (blocks.isEmpty || blocks.last.kind != _BlockKind.paragraph);

    if (headingLevel > 0) {
      blocks.add(_Block(
        kind: _BlockKind.heading,
        level: headingLevel,
        size: line.size,
        lines: [line],
      ));
      continue;
    }

    if (listMatch != null) {
      blocks.add(_Block(
        kind: _BlockKind.list,
        level: 0,
        size: line.size,
        lines: [
          Line(
            y: line.y,
            x: line.x,
            endX: line.endX,
            size: line.size,
            bold: line.bold,
            italic: line.italic,
            text: listMatch.text,
          )
        ],
        ordered: listMatch.ordered,
        marker: listMatch.marker,
        indent: math.max(0, ((line.x - leftEdge) / 18).round()),
      ));
      continue;
    }

    final last = blocks.isEmpty ? null : blocks.last;
    if (!startsBlock && last != null && last.kind == _BlockKind.paragraph) {
      last.lines.add(line);
    } else if (last != null && last.kind == _BlockKind.list && !startsBlock) {
      last.lines.add(line);
    } else {
      blocks.add(_Block(kind: _BlockKind.paragraph, level: 0, size: line.size, lines: [line]));
    }
  }

  // Consecutive list items belong to one Markdown list; a blank line between
  // them would split it into separate lists in most renderers.
  final out = StringBuffer();
  _BlockKind? previousKind;

  for (final block in blocks) {
    final text = _renderBlock(block, options);
    if (text.trim().isEmpty) continue;
    if (out.isNotEmpty) {
      out.write(previousKind == _BlockKind.list && block.kind == _BlockKind.list ? '\n' : '\n\n');
    }
    out.write(text);
    previousKind = block.kind;
  }
  return out.toString();
}

String _renderBlock(_Block block, PdfLayoutOptions options) {
  final text = _joinLines(block.lines);
  if (text.trim().isEmpty) return '';

  if (block.kind == _BlockKind.heading) {
    final level = block.level.clamp(1, 6);
    return '${'#' * level} ${escapeInline(text).replaceAll(RegExp(r'\s+'), ' ')}';
  }
  if (block.kind == _BlockKind.list) {
    final indent = '  ' * math.min(block.indent, 4);
    final marker = block.ordered ? '${block.marker}.' : options.bullet;
    return '$indent$marker ${escapeInline(text)}';
  }

  final body = escapeBlock(text);
  return block.lines.every((l) => l.bold) && block.lines.length == 1 && text.length < 120
      ? '**$body**'
      : body;
}

String _joinLines(List<Line> lines) {
  var out = '';
  for (final line in lines) {
    if (out.isEmpty) {
      out = line.text;
      continue;
    }
    if (RegExp('[­-]\$').hasMatch(out) && RegExp(r'^[a-zà-ÿ]').hasMatch(line.text)) {
      out = out.substring(0, out.length - 1) + line.text;
    } else {
      out = '$out ${line.text}';
    }
  }
  return out.replaceAll(RegExp(r'\s+'), ' ').trim();
}

class _ListMatch {
  const _ListMatch(this.ordered, this.marker, this.text);

  final bool ordered;
  final String marker;
  final String text;
}

_ListMatch? _matchListItem(String text) {
  final bullet = _bulletPattern.firstMatch(text);
  if (bullet != null && bullet.group(2)!.trim().isNotEmpty) {
    return _ListMatch(false, bullet.group(1)!, bullet.group(2)!.trim());
  }

  final ordered = _orderedPattern.firstMatch(text);
  if (ordered != null && ordered.group(2)!.trim().length > 1) {
    return _ListMatch(true, ordered.group(1)!, ordered.group(2)!.trim());
  }

  final letter = _letterPattern.firstMatch(text);
  if (letter != null &&
      letter.group(2)!.trim().length > 2 &&
      RegExp(r'^[a-z]$').hasMatch(letter.group(1)!)) {
    return _ListMatch(false, letter.group(1)!, '${letter.group(1)}) ${letter.group(2)!.trim()}');
  }
  return null;
}

int _headingLevelFor(Line line, double bodySize, List<double> sizeLevels) {
  final text = line.text.trim();
  if (text.isEmpty || text.length > 160) return 0;

  final index = sizeLevels.indexWhere((size) => (size - line.size).abs() < 0.6);
  if (index >= 0 && line.size > bodySize * 1.08) return math.min(6, index + 1);

  if (line.bold &&
      line.size >= bodySize * 0.98 &&
      text.length < 90 &&
      !RegExp(r'[.;,]$').hasMatch(text)) {
    return math.min(6, sizeLevels.length + 1);
  }
  return 0;
}

double bodyFontSize(List<List<Line>> pages) {
  final weights = <double, int>{};
  for (final lines in pages) {
    for (final line in lines) {
      final key = (line.size * 2).round() / 2;
      weights[key] = (weights[key] ?? 0) + line.text.length;
    }
  }
  var best = 12.0;
  var bestWeight = -1;
  weights.forEach((size, weight) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  });
  return best;
}

/// Distinct heading sizes above the body size, largest first, capped at six.
List<double> headingSizeLevels(List<List<Line>> pages, double bodySize) {
  final sizes = <double>{};
  for (final lines in pages) {
    for (final line in lines) {
      final key = (line.size * 2).round() / 2;
      if (key > bodySize * 1.08 && line.text.trim().isNotEmpty) sizes.add(key);
    }
  }
  final ordered = sizes.toList()..sort((a, b) => b.compareTo(a));
  return ordered.take(6).toList();
}

double _median(List<double> values) {
  if (values.isEmpty) return 0;
  final sorted = List<double>.from(values)..sort();
  final mid = sorted.length ~/ 2;
  return sorted.length.isEven ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
