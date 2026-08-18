import 'dart:math' as math;
import 'dart:typed_data';

import 'document.dart';
import 'fonts.dart';
import 'lexer.dart';

/// Content-stream interpreter: operators in, positioned text runs out.
/// Mirrors `web/src/converters/pdf/content.ts`.
class TextItem {
  const TextItem({
    required this.x,
    required this.y,
    required this.width,
    required this.size,
    required this.text,
    required this.bold,
    required this.italic,
  });

  final double x;
  final double y;
  final double width;
  final double size;
  final String text;
  final bool bold;
  final bool italic;
}

typedef Matrix = List<double>;

const Matrix _identity = [1, 0, 0, 1, 0, 0];

Matrix _multiply(Matrix a, Matrix b) => [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4],
      a[4] * b[1] + a[5] * b[3] + b[5],
    ];

class _GraphicsState {
  _GraphicsState({
    required this.ctm,
    this.font,
    this.fontSize = 0,
    this.charSpacing = 0,
    this.wordSpacing = 0,
    this.hscale = 1,
    this.leading = 0,
    this.rise = 0,
  });

  Matrix ctm;
  PdfFont? font;
  double fontSize;
  double charSpacing;
  double wordSpacing;
  double hscale;
  double leading;
  double rise;

  _GraphicsState clone() => _GraphicsState(
        ctm: List<double>.from(ctm),
        font: font,
        fontSize: fontSize,
        charSpacing: charSpacing,
        wordSpacing: wordSpacing,
        hscale: hscale,
        leading: leading,
        rise: rise,
      );
}

List<TextItem> extractPageText(PdfDocument doc, PdfPage page) {
  final items = <TextItem>[];
  final content = doc.pageContent(page);
  if (content.isEmpty) return items;

  _ContentInterpreter(doc, items).run(content, page.resources, List<double>.from(_identity), 0);
  return items;
}

class _ContentInterpreter {
  _ContentInterpreter(this.doc, this.items);

  final PdfDocument doc;
  final List<TextItem> items;
  final Map<String, PdfFont> _fontCache = <String, PdfFont>{};
  final Set<String> _activeForms = <String>{};

  void run(Uint8List content, PdfDict? resources, Matrix baseCtm, int depth) {
    if (depth > 8) return;

    final lexer = Lexer(content, 0);
    var operands = <Object?>[];
    final stack = <_GraphicsState>[];

    var state = _GraphicsState(ctm: baseCtm);
    var tm = List<double>.from(_identity);
    var tlm = List<double>.from(_identity);

    double operand(int index) {
      final value = operands.length >= index ? operands[operands.length - index] : null;
      return value is num ? value.toDouble() : 0;
    }

    while (true) {
      final token = lexer.next();
      if (identical(token, endOfInput)) break;

      if (token is! PdfOperator) {
        operands.add(token);
        if (operands.length > 64) operands.removeAt(0);
        continue;
      }

      switch (token.op) {
        case 'q':
          stack.add(state.clone());
        case 'Q':
          if (stack.isNotEmpty) state = stack.removeLast();
        case 'cm':
          state.ctm = _multiply([operand(6), operand(5), operand(4), operand(3), operand(2), operand(1)], state.ctm);
        case 'BT':
          tm = List<double>.from(_identity);
          tlm = List<double>.from(_identity);
        case 'Tf':
          state.fontSize = operand(1);
          final nameOperand = operands.length >= 2 ? operands[operands.length - 2] : null;
          if (nameOperand is PdfName) state.font = _lookupFont(resources, nameOperand.name);
        case 'Td':
          tlm = _multiply([1, 0, 0, 1, operand(2), operand(1)], tlm);
          tm = List<double>.from(tlm);
        case 'TD':
          state.leading = -operand(1);
          tlm = _multiply([1, 0, 0, 1, operand(2), operand(1)], tlm);
          tm = List<double>.from(tlm);
        case 'Tm':
          tlm = [operand(6), operand(5), operand(4), operand(3), operand(2), operand(1)];
          tm = List<double>.from(tlm);
        case 'T*':
          tlm = _multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = List<double>.from(tlm);
        case 'TL':
          state.leading = operand(1);
        case 'Tc':
          state.charSpacing = operand(1);
        case 'Tw':
          state.wordSpacing = operand(1);
        case 'Tz':
          state.hscale = operand(1) / 100;
        case 'Ts':
          state.rise = operand(1);
        case 'Tj':
          final value = operands.isEmpty ? null : operands.last;
          if (value is PdfString) tm = _showText(state, tm, [value]);
        case "'":
          tlm = _multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = List<double>.from(tlm);
          final value = operands.isEmpty ? null : operands.last;
          if (value is PdfString) tm = _showText(state, tm, [value]);
        case '"':
          state.wordSpacing = operand(3);
          state.charSpacing = operand(2);
          tlm = _multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = List<double>.from(tlm);
          final value = operands.isEmpty ? null : operands.last;
          if (value is PdfString) tm = _showText(state, tm, [value]);
        case 'TJ':
          final array = operands.isEmpty ? null : operands.last;
          if (array is List) tm = _showText(state, tm, array);
        case 'Do':
          final nameOperand = operands.isEmpty ? null : operands.last;
          if (nameOperand is PdfName) _runXObject(resources, nameOperand.name, state, depth);
        case 'BI':
          _skipInlineImage(lexer);
        default:
          break;
      }
      operands = <Object?>[];
    }
  }

  PdfFont? _lookupFont(PdfDict? resources, String name) {
    final fonts = doc.dictGet(resources, ['Font']);
    if (fonts is! Map) return null;
    final ref = fonts[name];
    final cacheKey = ref is PdfRef ? ref.key : '$name@${fonts.length}';

    final cached = _fontCache[cacheKey];
    if (cached != null) return cached;

    final dict = doc.resolve(ref);
    if (dict is! Map) return null;

    final font = loadFont(doc, dict.cast<String, Object?>());
    _fontCache[cacheKey] = font;
    return font;
  }

  void _runXObject(PdfDict? resources, String name, _GraphicsState state, int depth) {
    final xobjects = doc.dictGet(resources, ['XObject']);
    if (xobjects is! Map) return;

    final ref = xobjects[name];
    final key = ref is PdfRef ? ref.key : '$name@$depth';
    if (_activeForms.contains(key)) return;

    final stream = doc.resolve(ref);
    if (stream is! PdfStreamObject) return;

    final subtype = doc.dictGet(stream.dict, ['Subtype']);
    if (subtype is! PdfName || subtype.name != 'Form') return;

    final matrixValue = doc.dictGet(stream.dict, ['Matrix']);
    var ctm = state.ctm;
    if (matrixValue is List && matrixValue.length == 6) {
      final m = matrixValue.map((v) {
        final resolved = doc.resolve(v);
        return resolved is num ? resolved.toDouble() : 0.0;
      }).toList();
      ctm = _multiply(m, ctm);
    }

    final formResources = doc.dictGet(stream.dict, ['Resources']);
    final data = doc.streamData(stream, ref is PdfRef ? ref : null);

    _activeForms.add(key);
    run(
      data,
      formResources is Map ? formResources.cast<String, Object?>() : resources,
      ctm,
      depth + 1,
    );
    _activeForms.remove(key);
  }

  Matrix _showText(_GraphicsState state, Matrix tmIn, List<Object?> parts) {
    var tm = tmIn;
    final font = state.font;
    if (font == null || state.fontSize == 0) return tm;

    Matrix trmOf(Matrix matrix) => _multiply(
          [state.fontSize * state.hscale, 0, 0, state.fontSize, 0, state.rise],
          _multiply(matrix, state.ctm),
        );

    final startTrm = trmOf(tm);
    final size = math.sqrt(startTrm[2] * startTrm[2] + startTrm[3] * startTrm[3]);
    final buffer = StringBuffer();

    for (final part in parts) {
      if (part is num) {
        final shift = (-part.toDouble() / 1000) * state.fontSize * state.hscale;
        tm = _multiply([1, 0, 0, 1, shift, 0], tm);
        // A kern wider than a fifth of an em is how most producers write a space.
        final text = buffer.toString();
        if (shift > state.fontSize * 0.18 && text.isNotEmpty && !text.endsWith(' ')) {
          buffer.write(' ');
        }
        continue;
      }
      if (part is! PdfString) continue;

      for (final glyph in font.decode(part.bytes)) {
        buffer.write(glyph.text);
        final isSpaceCode = glyph.code == 32;
        final advance = ((glyph.width / 1000) * state.fontSize +
                state.charSpacing +
                (isSpaceCode ? state.wordSpacing : 0)) *
            state.hscale;
        tm = _multiply([1, 0, 0, 1, advance, 0], tm);
      }
    }

    final text = buffer.toString();
    if (text.trim().isEmpty) return tm;

    final endTrm = trmOf(tm);
    final dx = endTrm[4] - startTrm[4];
    final dy = endTrm[5] - startTrm[5];
    items.add(TextItem(
      x: startTrm[4],
      y: startTrm[5],
      width: math.max(0, math.sqrt(dx * dx + dy * dy)),
      size: size == 0 ? state.fontSize : size,
      text: text,
      bold: font.bold,
      italic: font.italic,
    ));
    return tm;
  }
}

/// Inline images embed raw bytes between `ID` and `EI`; step over them.
void _skipInlineImage(Lexer lexer) {
  final bytes = lexer.bytes;
  var i = lexer.pos;

  while (i + 1 < bytes.length) {
    if (bytes[i] == 0x49 && bytes[i + 1] == 0x44) {
      i += 2;
      break;
    }
    i++;
  }
  if (i < bytes.length && (bytes[i] == 0x20 || bytes[i] == 0x0a || bytes[i] == 0x0d)) i++;

  while (i + 1 < bytes.length) {
    final beforeOk = i == 0 || bytes[i - 1] == 0x20 || bytes[i - 1] == 0x0a || bytes[i - 1] == 0x0d;
    final afterOk = i + 2 >= bytes.length ||
        bytes[i + 2] == 0x20 ||
        bytes[i + 2] == 0x0a ||
        bytes[i + 2] == 0x0d;
    if (bytes[i] == 0x45 && bytes[i + 1] == 0x49 && beforeOk && afterOk) {
      lexer.pos = i + 2;
      return;
    }
    i++;
  }
  lexer.pos = bytes.length;
}
