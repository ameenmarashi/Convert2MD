import 'dart:convert';

import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/text_decode.dart';

/// Plain text, Markdown, source code, JSON and subtitles → Markdown.
/// Mirrors `web/src/converters/text.ts`.
const Set<String> _codeExtensions = {
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cc', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r', 'scala', 'dart', 'lua',
  'pl', 'vim', 'toml', 'ini', 'cfg', 'conf', 'gradle', 'tf', 'dockerfile', 'makefile', 'm', 'mm',
};

RawOutput convertText(SourceFile file, ConvertOptions options) {
  final decoded = decodeText(file.bytes);
  final extension = file.name.contains('.') ? file.name.split('.').last.toLowerCase() : '';
  final meta = {'encoding': decoded.encoding};
  final warnings = <String>[];

  if (const {'md', 'markdown', 'mdown', 'mkd'}.contains(extension)) {
    return RawOutput(markdown: normalizeMarkdown(decoded.text), meta: meta);
  }
  if (const {'json', 'jsonl', 'ndjson'}.contains(extension)) {
    return RawOutput(
      markdown: _jsonToMarkdown(decoded.text, extension, warnings),
      meta: meta,
      warnings: warnings,
    );
  }
  if (extension == 'srt' || extension == 'vtt') {
    return RawOutput(markdown: _subtitlesToMarkdown(decoded.text), meta: meta);
  }
  if (const {'yaml', 'yml', 'xml', 'svg'}.contains(extension)) {
    return RawOutput(markdown: codeBlock(decoded.text.trim(), fenceLanguage(extension)), meta: meta);
  }
  if (_codeExtensions.contains(extension)) {
    return RawOutput(
      markdown: codeBlock(decoded.text.replaceFirst(RegExp(r'\s+$'), ''), fenceLanguage(extension)),
      meta: meta,
    );
  }

  return RawOutput(markdown: plainTextToMarkdown(decoded.text, options), meta: meta);
}

final RegExp _bulletLine = RegExp(r'^(\s*)([-*+•·▪◦‣o])\s+(.+)$');
final RegExp _orderedLine = RegExp(r'^(\s*)(\d{1,3})[.)]\s+(.+)$');
final RegExp _setextUnderline = RegExp(r'^\s*(={3,}|-{3,}|~{3,}|\*{3,}|_{3,})\s*$');

String plainTextToMarkdown(String text, ConvertOptions options) {
  final lines = text.replaceAll(RegExp(r'\r\n?'), '\n').replaceAll('\t', '    ').split('\n');
  final writer = MarkdownWriter();

  var paragraph = <String>[];
  var listBuffer = <String>[];

  void flushParagraph() {
    if (paragraph.isEmpty) return;
    final joined = options.preserveLineBreaks
        ? paragraph.map((l) => escapeBlock(l.trim())).join('  \n')
        : escapeBlock(paragraph.join(' ').replaceAll(RegExp(r'\s+'), ' ').trim());
    writer.push(joined);
    paragraph = <String>[];
  }

  void flushList() {
    if (listBuffer.isEmpty) return;
    writer.push(listBuffer.join('\n'));
    listBuffer = <String>[];
  }

  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final trimmed = line.trim();

    if (trimmed.isEmpty) {
      flushParagraph();
      flushList();
      continue;
    }

    final next = i + 1 < lines.length ? lines[i + 1] : '';
    if (_setextUnderline.hasMatch(next) && trimmed.length <= 120) {
      flushParagraph();
      flushList();
      writer.heading(next.trim().startsWith('=') ? 1 : 2, trimmed);
      i++;
      continue;
    }

    if (_setextUnderline.hasMatch(line)) {
      flushParagraph();
      flushList();
      writer.rule();
      continue;
    }

    final bullet = _bulletLine.firstMatch(line);
    if (bullet != null) {
      flushParagraph();
      final depth = (bullet.group(1)!.length ~/ 2).clamp(0, 4);
      listBuffer.add('${'  ' * depth}${options.bulletChar} ${escapeBlock(bullet.group(3)!.trim())}');
      continue;
    }

    final ordered = _orderedLine.firstMatch(line);
    if (ordered != null) {
      flushParagraph();
      final depth = (ordered.group(1)!.length ~/ 2).clamp(0, 4);
      listBuffer
          .add('${'  ' * depth}${ordered.group(2)}. ${escapeBlock(ordered.group(3)!.trim())}');
      continue;
    }

    flushList();

    if (_isHeadingLike(trimmed, next)) {
      flushParagraph();
      writer.heading(trimmed.length < 40 ? 2 : 3, trimmed);
      continue;
    }

    paragraph.add(trimmed);
  }

  flushParagraph();
  flushList();
  return writer.isEmpty ? '' : writer.toString();
}

bool _isHeadingLike(String line, String next) {
  if (line.length > 80 || line.length < 3) return false;
  if (RegExp(r'[.,;]$').hasMatch(line)) return false;
  if (next.trim().isEmpty) {
    final letters = line.replaceAll(RegExp('[^A-Za-z]'), '');
    if (letters.length >= 3 && letters == letters.toUpperCase()) return true;
  }
  return RegExp(r'^(chapter|section|part|appendix)\s+[\dIVXivx]+', caseSensitive: false)
      .hasMatch(line);
}

String _jsonToMarkdown(String text, String extension, List<String> warnings) {
  if (extension == 'jsonl' || extension == 'ndjson') {
    final rows = <Map<String, Object?>>[];
    for (final line in text.split('\n')) {
      if (line.trim().isEmpty) continue;
      try {
        final value = jsonDecode(line);
        if (_isFlatRecord(value)) rows.add(value as Map<String, Object?>);
      } on FormatException {
        // Skip unparsable lines; the rest of the file still converts.
      }
    }
    final table = _recordsToTable(rows);
    if (table != null) return table;
  }

  Object? parsed;
  try {
    parsed = jsonDecode(text);
  } on FormatException catch (error) {
    warnings.add('The JSON could not be parsed (${error.message}); kept as a code block.');
    return codeBlock(text.trim(), 'json');
  }

  if (parsed is List && parsed.isNotEmpty && parsed.every(_isFlatRecord)) {
    final table = _recordsToTable(parsed.cast<Map<String, Object?>>());
    if (table != null) return table;
  }
  return codeBlock(const JsonEncoder.withIndent('  ').convert(parsed), 'json');
}

bool _isFlatRecord(Object? value) {
  if (value is! Map) return false;
  return value.values.every((v) => v == null || v is String || v is num || v is bool);
}

String? _recordsToTable(List<Map<String, Object?>> records) {
  if (records.isEmpty) return null;
  final columns = <String>[];
  for (final record in records) {
    for (final key in record.keys) {
      if (!columns.contains(key)) columns.add(key);
    }
  }
  if (columns.isEmpty || columns.length > 24) return null;

  final rows = <List<String>>[
    columns,
    ...records.map((record) => columns.map((key) => record[key]?.toString() ?? '').toList()),
  ];
  return renderTable(rows);
}

String _subtitlesToMarkdown(String text) {
  final writer = MarkdownWriter();
  final normalised = text.replaceAll(RegExp(r'\r\n?'), '\n').replaceFirst(RegExp(r'^WEBVTT.*\n'), '');

  for (final block in normalised.split(RegExp(r'\n{2,}'))) {
    final lines = block.split('\n').where((l) => l.trim().isNotEmpty).toList();
    if (lines.isEmpty) continue;

    final timingIndex = lines.indexWhere((l) => l.contains('-->'));
    if (timingIndex == -1) {
      writer.paragraph(escapeBlock(lines.join(' ')));
      continue;
    }

    final timing = lines[timingIndex]
        .replaceFirst(RegExp(r'\s*-->\s*'), ' → ')
        .replaceAll(',', '.')
        .split(' ')
        .take(3)
        .join(' ');
    final body = lines
        .skip(timingIndex + 1)
        .join(' ')
        .replaceAll(RegExp('<[^>]+>'), '')
        .trim();
    if (body.isNotEmpty) writer.push('**$timing**  \n${escapeBlock(body)}');
  }
  return writer.toString();
}
