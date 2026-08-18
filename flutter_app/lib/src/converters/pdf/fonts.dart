import 'dart:typed_data';

import 'document.dart';
import 'encoding.dart';
import 'lexer.dart';

/// Font handling: code → Unicode and code → advance width.
/// Mirrors `web/src/converters/pdf/fonts.ts`.
class Glyph {
  const Glyph(this.code, this.text, this.width);

  final int code;
  final String text;

  /// Advance in text-space units (1/1000 em).
  final double width;
}

class PdfFont {
  const PdfFont({
    required this.name,
    required this.bold,
    required this.italic,
    required this.serif,
    required bool twoByte,
    required Map<int, String> toUnicode,
    required List<String?>? simpleTable,
    required Map<int, double> widths,
    required double defaultWidth,
  })  : _twoByte = twoByte,
        _toUnicode = toUnicode,
        _simpleTable = simpleTable,
        _widths = widths,
        _defaultWidth = defaultWidth;

  final String name;
  final bool bold;
  final bool italic;
  final bool serif;

  final bool _twoByte;
  final Map<int, String> _toUnicode;
  final List<String?>? _simpleTable;
  final Map<int, double> _widths;
  final double _defaultWidth;

  List<Glyph> decode(Uint8List bytes) {
    final glyphs = <Glyph>[];
    final step = _twoByte ? 2 : 1;

    for (var i = 0; i + step <= bytes.length; i += step) {
      final code = step == 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      glyphs.add(Glyph(code, _textFor(code), _widthFor(code)));
    }
    if (step == 2 && bytes.length.isOdd) {
      final code = bytes[bytes.length - 1];
      glyphs.add(Glyph(code, _textFor(code), _widthFor(code)));
    }
    return glyphs;
  }

  String _textFor(int code) {
    final mapped = _toUnicode[code];
    if (mapped != null) return mapped;
    final table = _simpleTable;
    if (table != null) return code < table.length ? (table[code] ?? '') : '';
    // Identity-encoded CID font without a ToUnicode map: nothing reliable to show.
    return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
  }

  double _widthFor(int code) => _widths[code] ?? _defaultWidth;
}

PdfFont loadFont(PdfDocument doc, PdfDict dict) {
  final subtype = _nameOf(doc.dictGet(dict, ['Subtype'])) ?? '';
  final baseFont = _nameOf(doc.dictGet(dict, ['BaseFont'])) ?? '';
  final lowerName = baseFont.toLowerCase();
  final toUnicode = _readToUnicode(doc, dict);

  if (subtype == 'Type0') {
    final descendants = doc.dictGet(dict, ['DescendantFonts']);
    final descendant = descendants is List && descendants.isNotEmpty
        ? doc.resolve(descendants.first)
        : null;
    final cid = descendant is Map ? descendant.cast<String, Object?>() : null;

    final defaultWidth = _numberOf(doc.dictGet(cid, ['DW']), 1000);
    final flags = _readFlags(doc, cid);

    return PdfFont(
      name: baseFont,
      bold: _isBold(lowerName, doc, cid),
      italic: _isItalic(lowerName, flags),
      serif: (flags & 2) != 0,
      twoByte: true,
      toUnicode: toUnicode,
      simpleTable: null,
      widths: _readCidWidths(doc, cid),
      defaultWidth: defaultWidth,
    );
  }

  final flags = _readFlags(doc, dict);
  final symbolic = (flags & 4) != 0 && (flags & 32) == 0;
  final table = _readSimpleEncoding(doc, dict, symbolic);
  final metrics = _readSimpleWidths(doc, dict, subtype);

  return PdfFont(
    name: baseFont,
    bold: _isBold(lowerName, doc, dict),
    italic: _isItalic(lowerName, flags),
    serif: (flags & 2) != 0,
    twoByte: false,
    toUnicode: toUnicode,
    simpleTable: table,
    widths: metrics.widths,
    defaultWidth: metrics.defaultWidth,
  );
}

class _Metrics {
  const _Metrics(this.widths, this.defaultWidth);

  final Map<int, double> widths;
  final double defaultWidth;
}

int _readFlags(PdfDocument doc, PdfDict? dict) {
  final descriptor = doc.dictGet(dict, ['FontDescriptor']);
  if (descriptor is! Map) return 0;
  return _numberOf(doc.dictGet(descriptor.cast<String, Object?>(), ['Flags']), 0).toInt();
}

bool _isBold(String lowerName, PdfDocument doc, PdfDict? dict) {
  if (RegExp(r'bold|black|heavy|semibold|[-,]bd\b').hasMatch(lowerName)) return true;
  final descriptor = doc.dictGet(dict, ['FontDescriptor']);
  if (descriptor is Map) {
    final d = descriptor.cast<String, Object?>();
    if (_numberOf(doc.dictGet(d, ['FontWeight']), 400) >= 600) return true;
    if (_numberOf(doc.dictGet(d, ['StemV']), 0) >= 120) return true;
  }
  return false;
}

bool _isItalic(String lowerName, int flags) =>
    RegExp(r'italic|oblique|[-,]it\b').hasMatch(lowerName) || (flags & 64) != 0;

List<String?> _readSimpleEncoding(PdfDocument doc, PdfDict dict, bool symbolic) {
  final encoding = doc.dictGet(dict, ['Encoding']);
  var baseName = symbolic ? 'StandardEncoding' : 'WinAnsiEncoding';
  var differences = const <Object?>[];

  if (encoding is PdfName) {
    baseName = encoding.name;
  } else if (encoding is Map) {
    final dictEncoding = encoding.cast<String, Object?>();
    final base = doc.dictGet(dictEncoding, ['BaseEncoding']);
    if (base is PdfName) baseName = base.name;
    final diff = doc.dictGet(dictEncoding, ['Differences']);
    if (diff is List) differences = diff;
  }

  final table = baseEncodingTable(baseName);

  var code = 0;
  for (final entry in differences) {
    final value = doc.resolve(entry);
    if (value is num) {
      code = value.toInt();
    } else if (value is PdfName) {
      if (code >= 0 && code < 256) table[code] = glyphNameToUnicode(value.name);
      code++;
    }
  }
  return table;
}

_Metrics _readSimpleWidths(PdfDocument doc, PdfDict dict, String subtype) {
  final widths = <int, double>{};
  final first = _numberOf(doc.dictGet(dict, ['FirstChar']), 0).toInt();
  final list = doc.dictGet(dict, ['Widths']);

  var scale = 1.0;
  if (subtype == 'Type3') {
    final matrix = doc.dictGet(dict, ['FontMatrix']);
    if (matrix is List && matrix.isNotEmpty) {
      final value = doc.resolve(matrix.first);
      if (value is num) scale = value.toDouble() * 1000;
    }
  }

  if (list is List) {
    for (var index = 0; index < list.length; index++) {
      final value = doc.resolve(list[index]);
      if (value is num) widths[first + index] = value.toDouble() * scale;
    }
  }

  var defaultWidth = 500.0;
  final descriptor = doc.dictGet(dict, ['FontDescriptor']);
  if (descriptor is Map) {
    final missing = doc.dictGet(descriptor.cast<String, Object?>(), ['MissingWidth']);
    if (missing is num && missing > 0) defaultWidth = missing.toDouble();
  }

  if (widths.isEmpty) {
    // No metrics at all: approximate a proportional Latin face.
    widths[32] = 278;
    for (var c = 33; c < 127; c++) {
      widths[c] = RegExp(r'''[ijltfr.,;:'"|!]''').hasMatch(String.fromCharCode(c)) ? 280 : 556;
    }
    for (var c = 65; c <= 90; c++) {
      widths[c] = 667;
    }
  }
  return _Metrics(widths, defaultWidth);
}

Map<int, double> _readCidWidths(PdfDocument doc, PdfDict? cid) {
  final widths = <int, double>{};
  final w = doc.dictGet(cid, ['W']);
  if (w is! List) return widths;

  var i = 0;
  while (i < w.length) {
    final start = doc.resolve(w[i]);
    if (start is! num) break;
    final second = i + 1 < w.length ? doc.resolve(w[i + 1]) : null;

    if (second is List) {
      for (var index = 0; index < second.length; index++) {
        final value = doc.resolve(second[index]);
        if (value is num) widths[start.toInt() + index] = value.toDouble();
      }
      i += 2;
    } else if (second is num) {
      final value = i + 2 < w.length ? doc.resolve(w[i + 2]) : null;
      if (value is! num) break;
      final end = second.toInt() > start.toInt() + 65535 ? start.toInt() + 65535 : second.toInt();
      for (var code = start.toInt(); code <= end; code++) {
        widths[code] = value.toDouble();
      }
      i += 3;
    } else {
      break;
    }
  }
  return widths;
}

Map<int, String> _readToUnicode(PdfDocument doc, PdfDict dict) {
  final value = dict['ToUnicode'];
  final stream = doc.resolve(value);
  if (stream is! PdfStreamObject) return const {};
  final data = doc.streamData(stream, value is PdfRef ? value : null);
  if (data.isEmpty) return const {};
  try {
    return parseCMap(data);
  } catch (_) {
    return const {};
  }
}

/// Parse the bfchar/bfrange sections of a ToUnicode CMap.
Map<int, String> parseCMap(Uint8List data) {
  final map = <int, String>{};
  final lexer = Lexer(data, 0);
  var operands = <Object?>[];

  while (true) {
    final token = lexer.next();
    if (identical(token, endOfInput)) break;

    if (token is! PdfOperator) {
      operands.add(token);
      if (operands.length > 600) operands = operands.sublist(operands.length - 600);
      continue;
    }

    switch (token.op) {
      case 'endbfchar':
        for (var i = 0; i + 1 < operands.length; i += 2) {
          final src = operands[i];
          final dst = operands[i + 1];
          if (src is! PdfString) continue;
          if (dst is PdfString) {
            map[_codeOf(src)] = _utf16BE(dst.bytes);
          } else if (dst is PdfName) {
            final text = glyphNameToUnicode(dst.name);
            if (text != null) map[_codeOf(src)] = text;
          }
        }
        operands = <Object?>[];
      case 'endbfrange':
        for (var i = 0; i + 2 < operands.length; i += 3) {
          final lo = operands[i];
          final hi = operands[i + 1];
          final dst = operands[i + 2];
          if (lo is! PdfString || hi is! PdfString) continue;

          final start = _codeOf(lo);
          final hiCode = _codeOf(hi);
          final end = hiCode > start + 65535 ? start + 65535 : hiCode;

          if (dst is List) {
            for (var index = 0; index < dst.length; index++) {
              final entry = dst[index];
              if (entry is PdfString) map[start + index] = _utf16BE(entry.bytes);
            }
          } else if (dst is PdfString) {
            final base = _utf16BE(dst.bytes);
            if (base.isEmpty) continue;
            final codePoints = base.runes.toList();
            for (var code = start; code <= end; code++) {
              final shifted = codePoints.last + (code - start);
              final replaced = [...codePoints.sublist(0, codePoints.length - 1), shifted];
              map[code] = String.fromCharCodes(replaced.where((c) => c >= 0 && c <= 0x10ffff));
            }
          }
        }
        operands = <Object?>[];
      case 'endcodespacerange':
      case 'endcidrange':
      case 'endcidchar':
      case 'endnotdefrange':
      case 'begincodespacerange':
      case 'beginbfchar':
      case 'beginbfrange':
      case 'begincidrange':
      case 'begincidchar':
        operands = <Object?>[];
      default:
        break;
    }
  }
  return map;
}

int _codeOf(PdfString value) {
  var code = 0;
  for (final byte in value.bytes) {
    code = (code << 8) | byte;
  }
  return code;
}

String _utf16BE(Uint8List bytes) {
  if (bytes.length == 1) return String.fromCharCode(bytes[0]);
  final units = <int>[];
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    units.add((bytes[i] << 8) | bytes[i + 1]);
  }
  return String.fromCharCodes(units);
}

String? _nameOf(Object? value) => value is PdfName ? value.name : null;

double _numberOf(Object? value, double fallback) => value is num ? value.toDouble() : fallback;
