import 'dart:typed_data';

/// PDF object model and tokenizer (PDF 32000-1, clause 7.3).
/// Mirrors `web/src/converters/pdf/lexer.ts`.
class PdfName {
  const PdfName(this.name);

  final String name;

  @override
  bool operator ==(Object other) => other is PdfName && other.name == name;

  @override
  int get hashCode => name.hashCode;

  @override
  String toString() => '/$name';
}

class PdfRef {
  const PdfRef(this.num, this.gen);

  final int num;
  final int gen;

  String get key => '$num:$gen';

  @override
  bool operator ==(Object other) => other is PdfRef && other.num == num && other.gen == gen;

  @override
  int get hashCode => Object.hash(num, gen);
}

class PdfString {
  const PdfString(this.bytes);

  final Uint8List bytes;
}

class PdfOperator {
  const PdfOperator(this.op);

  final String op;

  @override
  String toString() => op;
}

typedef PdfDict = Map<String, Object?>;

class PdfStreamObject {
  const PdfStreamObject(this.dict, this.raw);

  final PdfDict dict;
  final Uint8List raw;
}

const Set<int> _whitespace = {0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20};
const Set<int> _delimiters = {0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25};

bool isPdfWhitespace(int byte) => _whitespace.contains(byte);

bool isPdfRegular(int byte) => !_whitespace.contains(byte) && !_delimiters.contains(byte);

class Lexer {
  Lexer(this.bytes, [int start = 0]) : pos = start;

  final Uint8List bytes;
  int pos;

  bool get atEnd => pos >= bytes.length;

  void skipWhitespace() {
    while (pos < bytes.length) {
      final byte = bytes[pos];
      if (_whitespace.contains(byte)) {
        pos++;
      } else if (byte == 0x25) {
        while (pos < bytes.length && bytes[pos] != 0x0a && bytes[pos] != 0x0d) {
          pos++;
        }
      } else {
        return;
      }
    }
  }

  /// Next raw token: object, operator keyword, or null at end of input.
  Object? next() {
    skipWhitespace();
    if (atEnd) return _endOfInput;

    final byte = bytes[pos];

    if (byte == 0x2f) return _readName();
    if (byte == 0x28) return _readLiteralString();
    if (byte == 0x3c) {
      if (pos + 1 < bytes.length && bytes[pos + 1] == 0x3c) {
        pos += 2;
        return readDictionary();
      }
      return _readHexString();
    }
    if (byte == 0x5b) {
      pos++;
      return _readArray();
    }
    if (byte == 0x5d || byte == 0x3e || byte == 0x29 || byte == 0x7b || byte == 0x7d) {
      pos++;
      return PdfOperator(String.fromCharCode(byte));
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte == 0x2b || byte == 0x2d || byte == 0x2e) {
      return _readNumberOrRef();
    }
    return _readKeyword();
  }

  Object? _readKeyword() {
    final start = pos;
    while (pos < bytes.length && isPdfRegular(bytes[pos])) {
      pos++;
    }
    if (pos == start) {
      pos++;
      return PdfOperator(String.fromCharCode(bytes[start]));
    }
    final word = latin1Of(bytes, start, pos);
    if (word == 'true') return true;
    if (word == 'false') return false;
    if (word == 'null') return null;
    return PdfOperator(word);
  }

  PdfName _readName() {
    pos++;
    final buffer = StringBuffer();
    while (pos < bytes.length && isPdfRegular(bytes[pos])) {
      final byte = bytes[pos];
      if (byte == 0x23 && pos + 2 < bytes.length) {
        final code = int.tryParse(latin1Of(bytes, pos + 1, pos + 3), radix: 16);
        if (code != null) {
          buffer.writeCharCode(code);
          pos += 3;
          continue;
        }
      }
      buffer.writeCharCode(byte);
      pos++;
    }
    return PdfName(buffer.toString());
  }

  Object? _readNumberOrRef() {
    final first = _readNumber();
    if (first != first.roundToDouble() || first < 0) return first;

    final save = pos;
    skipWhitespace();
    final genStart = pos;
    if (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) {
      final gen = _readNumber();
      if (gen == gen.roundToDouble()) {
        skipWhitespace();
        if (pos < bytes.length &&
            bytes[pos] == 0x52 &&
            (pos + 1 >= bytes.length || !isPdfRegular(bytes[pos + 1]))) {
          pos++;
          return PdfRef(first.toInt(), gen.toInt());
        }
      }
      pos = genStart;
    }
    pos = save;
    return first;
  }

  double _readNumber() {
    final start = pos;
    if (bytes[pos] == 0x2b || bytes[pos] == 0x2d) pos++;
    while (pos < bytes.length) {
      final byte = bytes[pos];
      if ((byte >= 0x30 && byte <= 0x39) ||
          byte == 0x2e ||
          byte == 0x2d ||
          byte == 0x2b ||
          byte == 0x45 ||
          byte == 0x65) {
        pos++;
      } else {
        break;
      }
    }
    return double.tryParse(latin1Of(bytes, start, pos)) ?? 0;
  }

  PdfString _readLiteralString() {
    pos++;
    final out = <int>[];
    var depth = 1;

    while (pos < bytes.length) {
      final byte = bytes[pos++];

      if (byte == 0x5c) {
        if (pos >= bytes.length) break;
        final escape = bytes[pos++];
        switch (escape) {
          case 0x6e:
            out.add(0x0a);
          case 0x72:
            out.add(0x0d);
          case 0x74:
            out.add(0x09);
          case 0x62:
            out.add(0x08);
          case 0x66:
            out.add(0x0c);
          case 0x28:
            out.add(0x28);
          case 0x29:
            out.add(0x29);
          case 0x5c:
            out.add(0x5c);
          case 0x0d:
            if (pos < bytes.length && bytes[pos] == 0x0a) pos++;
          case 0x0a:
            break;
          default:
            if (escape >= 0x30 && escape <= 0x37) {
              var code = escape - 0x30;
              for (var i = 0; i < 2; i++) {
                if (pos >= bytes.length) break;
                final digit = bytes[pos];
                if (digit >= 0x30 && digit <= 0x37) {
                  code = code * 8 + (digit - 0x30);
                  pos++;
                } else {
                  break;
                }
              }
              out.add(code & 0xff);
            } else {
              out.add(escape);
            }
        }
        continue;
      }

      if (byte == 0x28) {
        depth++;
      } else if (byte == 0x29) {
        depth--;
        if (depth == 0) break;
      }
      out.add(byte);
    }
    return PdfString(Uint8List.fromList(out));
  }

  PdfString _readHexString() {
    pos++;
    final digits = <int>[];
    while (pos < bytes.length) {
      final byte = bytes[pos++];
      if (byte == 0x3e) break;
      final value = _hexValue(byte);
      if (value >= 0) digits.add(value);
    }
    if (digits.length.isOdd) digits.add(0);
    final out = Uint8List(digits.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = (digits[i * 2] << 4) | digits[i * 2 + 1];
    }
    return PdfString(out);
  }

  List<Object?> _readArray() {
    final out = <Object?>[];
    while (true) {
      skipWhitespace();
      if (atEnd) break;
      if (bytes[pos] == 0x5d) {
        pos++;
        break;
      }
      final value = next();
      if (identical(value, _endOfInput)) break;
      if (value is PdfOperator) {
        if (value.op == ']') break;
        continue;
      }
      out.add(value);
    }
    return out;
  }

  PdfDict readDictionary() {
    final dict = <String, Object?>{};
    while (true) {
      skipWhitespace();
      if (atEnd) break;
      if (bytes[pos] == 0x3e && pos + 1 < bytes.length && bytes[pos + 1] == 0x3e) {
        pos += 2;
        break;
      }
      final key = next();
      if (identical(key, _endOfInput)) break;
      if (key is! PdfName) continue;

      final value = next();
      if (identical(value, _endOfInput)) break;
      if (value is PdfOperator) continue;
      dict[key.name] = value;
    }
    return dict;
  }
}

/// Sentinel distinguishing "end of input" from a genuine PDF `null` token.
const Object _endOfInput = Object();

const Object endOfInput = _endOfInput;

int _hexValue(int byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

String latin1Of(Uint8List bytes, [int start = 0, int? end]) {
  return String.fromCharCodes(bytes, start, end ?? bytes.length);
}

/// Decode a PDF text string: UTF-16BE with BOM, else PDFDocEncoding ≈ Latin-1.
String decodePdfTextString(PdfString value) {
  final bytes = value.bytes;
  if (bytes.length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) {
    final units = <int>[];
    for (var i = 2; i + 1 < bytes.length; i += 2) {
      units.add((bytes[i] << 8) | bytes[i + 1]);
    }
    return String.fromCharCodes(units);
  }
  return String.fromCharCodes(bytes);
}
