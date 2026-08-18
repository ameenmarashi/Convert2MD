import '../core/conversion.dart';
import '../core/markdown.dart';
import '../core/text_decode.dart';

/// CSV / TSV → Markdown table. Mirrors `web/src/converters/csv.ts`.
const int _maxRows = 5000;

RawOutput convertCsv(SourceFile file, ConvertOptions options) {
  final decoded = decodeText(file.bytes);
  final extension = file.name.split('.').last.toLowerCase();
  final delimiter = extension == 'tsv' ? '\t' : sniffDelimiter(decoded.text);
  final warnings = <String>[];

  var rows = parseDelimited(decoded.text, delimiter)
      .where((row) => row.any((cell) => cell.trim().isNotEmpty))
      .toList();

  if (rows.isEmpty) {
    return RawOutput(
      markdown: '_The file contains no rows._\n',
      meta: {'encoding': decoded.encoding},
    );
  }

  if (rows.length > _maxRows) {
    warnings.add('Only the first $_maxRows rows were converted (the file has ${rows.length}).');
    rows = rows.sublist(0, _maxRows);
  }

  final width = rows.fold<int>(0, (max, row) => row.length > max ? row.length : max);
  final normalised = rows.map((row) {
    final copy = List<String>.from(row);
    while (copy.length < width) {
      copy.add('');
    }
    return copy;
  }).toList();

  final writer = MarkdownWriter();
  writer.push(renderTable(normalised, align: _inferAlignment(normalised)));

  return RawOutput(
    markdown: writer.toString(),
    meta: {
      'encoding': decoded.encoding,
      'rows': '${normalised.length - 1}',
      'columns': '$width',
      'delimiter': delimiter == '\t' ? 'tab' : delimiter,
    },
    warnings: warnings,
  );
}

String sniffDelimiter(String text) {
  final sample = text.substring(0, text.length < 8192 ? text.length : 8192).split(RegExp(r'\r?\n'));
  final lines = sample.length > 20 ? sample.sublist(0, 20) : sample;
  const candidates = [',', ';', '\t', '|'];

  var best = ',';
  var bestScore = double.negativeInfinity;

  for (final candidate in candidates) {
    final counts = lines.map((line) => _countOutsideQuotes(line, candidate)).where((c) => c > 0);
    if (counts.isEmpty) continue;

    final average = counts.reduce((a, b) => a + b) / counts.length;
    final variance =
        counts.map((c) => (c - average) * (c - average)).reduce((a, b) => a + b) / counts.length;
    final score = average * counts.length - variance * 2;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

int _countOutsideQuotes(String line, String delimiter) {
  var count = 0;
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (ch == '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] == '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch == delimiter) {
      count++;
    }
  }
  return count;
}

List<List<String>> parseDelimited(String text, String delimiter) {
  final rows = <List<String>>[];
  var row = <String>[];
  var field = StringBuffer();
  var inQuotes = false;

  final source = text.replaceFirst('﻿', '');

  for (var i = 0; i < source.length; i++) {
    final ch = source[i];

    if (inQuotes) {
      if (ch == '"') {
        if (i + 1 < source.length && source[i + 1] == '"') {
          field.write('"');
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field.write(ch);
      }
      continue;
    }

    if (ch == '"' && field.toString().trim().isEmpty) {
      inQuotes = true;
      field = StringBuffer();
      continue;
    }
    if (ch == delimiter) {
      row.add(field.toString());
      field = StringBuffer();
      continue;
    }
    if (ch == '\n' || ch == '\r') {
      if (ch == '\r' && i + 1 < source.length && source[i + 1] == '\n') i++;
      row.add(field.toString());
      rows.add(row);
      row = <String>[];
      field = StringBuffer();
      continue;
    }
    field.write(ch);
  }

  if (field.isNotEmpty || row.isNotEmpty) {
    row.add(field.toString());
    rows.add(row);
  }
  return rows;
}

/// Right-align columns whose data cells are all numeric.
List<ColumnAlign?> _inferAlignment(List<List<String>> rows) {
  if (rows.length < 2) return const [];
  final width = rows.first.length;
  final align = <ColumnAlign?>[];

  for (var c = 0; c < width; c++) {
    var numeric = 0;
    var filled = 0;
    for (var r = 1; r < rows.length; r++) {
      final cell = rows[r][c].trim();
      if (cell.isEmpty) continue;
      filled++;
      if (RegExp(r'^[-+]?[\d.,]+%?$').hasMatch(cell) && RegExp(r'\d').hasMatch(cell)) numeric++;
    }
    align.add(filled > 0 && numeric == filled ? ColumnAlign.right : null);
  }
  return align;
}
