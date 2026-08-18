import 'dart:typed_data';

import 'package:archive/archive.dart';

import 'lexer.dart';

/// PDF stream filters (PDF 32000-1, clause 7.4) and predictor undoing.
/// Mirrors `web/src/converters/pdf/filters.ts`.
typedef Resolver = Object? Function(Object? value);

class DecodedStream {
  const DecodedStream(this.data, this.imageFilter);

  final Uint8List data;
  final String? imageFilter;
}

DecodedStream decodeStream(PdfDict dict, Uint8List raw, Resolver resolve) {
  final filters = _asList(resolve(dict['Filter'] ?? dict['F']), resolve)
      .whereType<PdfName>()
      .map((name) => name.name)
      .toList();
  final parms = _asList(resolve(dict['DecodeParms'] ?? dict['DP']), resolve);

  var data = raw;
  for (var i = 0; i < filters.length; i++) {
    final filter = filters[i];
    final parm = i < parms.length ? resolve(parms[i]) : null;
    final parmDict = parm is Map ? parm.cast<String, Object?>() : null;

    switch (filter) {
      case 'FlateDecode':
      case 'Fl':
        data = _applyPredictor(_inflate(data), parmDict, resolve);
      case 'LZWDecode':
      case 'LZW':
        final early = parmDict == null ? 1 : _numberOf(resolve(parmDict['EarlyChange']), 1).toInt();
        data = _applyPredictor(lzwDecode(data, early), parmDict, resolve);
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHexDecode(data);
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85Decode(data);
      case 'RunLengthDecode':
      case 'RL':
        data = runLengthDecode(data);
      case 'DCTDecode':
      case 'DCT':
      case 'JPXDecode':
      case 'JBIG2Decode':
      case 'CCITTFaxDecode':
      case 'CCF':
        return DecodedStream(data, filter);
      default:
        break;
    }
  }
  return DecodedStream(data, null);
}

Uint8List _inflate(Uint8List data) {
  if (data.isEmpty) return data;
  // Try the zlib wrapper first; some producers emit a raw DEFLATE stream.
  try {
    return Uint8List.fromList(const ZLibDecoder().decodeBytes(data, verify: false));
  } catch (_) {
    try {
      return Uint8List.fromList(Inflate(data).getBytes());
    } catch (_) {
      return Uint8List(0);
    }
  }
}

List<Object?> _asList(Object? value, Resolver resolve) {
  final resolved = resolve(value);
  if (resolved == null) return const [];
  return resolved is List ? resolved : [resolved];
}

double _numberOf(Object? value, double fallback) => value is num ? value.toDouble() : fallback;

Uint8List _applyPredictor(Uint8List data, PdfDict? parms, Resolver resolve) {
  if (parms == null) return data;
  final predictor = _numberOf(resolve(parms['Predictor']), 1).toInt();
  if (predictor <= 1) return data;

  final colors = _numberOf(resolve(parms['Colors']), 1).toInt();
  final bpc = _numberOf(resolve(parms['BitsPerComponent']), 8).toInt();
  final columns = _numberOf(resolve(parms['Columns']), 1).toInt();
  final bpp = ((colors * bpc) / 8).ceil();
  final rowLength = ((colors * bpc * columns) / 8).ceil();

  if (predictor == 2) return _tiffPredictor(data, colors, bpc, columns);
  if (rowLength <= 0) return data;

  final rows = data.length ~/ (rowLength + 1);
  final out = Uint8List(rows * rowLength);
  var previous = Uint8List(rowLength);

  for (var r = 0; r < rows; r++) {
    final type = data[r * (rowLength + 1)];
    final rowStart = r * rowLength;
    for (var i = 0; i < rowLength; i++) {
      out[rowStart + i] = data[r * (rowLength + 1) + 1 + i];
    }

    for (var i = 0; i < rowLength; i++) {
      final left = i >= bpp ? out[rowStart + i - bpp] : 0;
      final up = previous[i];
      final upLeft = i >= bpp ? previous[i - bpp] : 0;
      switch (type) {
        case 1:
          out[rowStart + i] = (out[rowStart + i] + left) & 0xff;
        case 2:
          out[rowStart + i] = (out[rowStart + i] + up) & 0xff;
        case 3:
          out[rowStart + i] = (out[rowStart + i] + ((left + up) >> 1)) & 0xff;
        case 4:
          out[rowStart + i] = (out[rowStart + i] + _paeth(left, up, upLeft)) & 0xff;
        default:
          break;
      }
    }
    previous = Uint8List.sublistView(out, rowStart, rowStart + rowLength);
  }
  return out;
}

int _paeth(int a, int b, int c) {
  final p = a + b - c;
  final pa = (p - a).abs();
  final pb = (p - b).abs();
  final pc = (p - c).abs();
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

Uint8List _tiffPredictor(Uint8List data, int colors, int bpc, int columns) {
  if (bpc != 8) return data;
  final rowLength = colors * columns;
  if (rowLength <= 0) return data;
  final rows = data.length ~/ rowLength;
  for (var r = 0; r < rows; r++) {
    final offset = r * rowLength;
    for (var i = colors; i < rowLength; i++) {
      data[offset + i] = (data[offset + i] + data[offset + i - colors]) & 0xff;
    }
  }
  return data;
}

Uint8List asciiHexDecode(Uint8List data) {
  final out = <int>[];
  var digit = -1;
  for (final byte in data) {
    if (byte == 0x3e) break;
    var value = -1;
    if (byte >= 0x30 && byte <= 0x39) {
      value = byte - 0x30;
    } else if (byte >= 0x41 && byte <= 0x46) {
      value = byte - 0x37;
    } else if (byte >= 0x61 && byte <= 0x66) {
      value = byte - 0x57;
    } else {
      continue;
    }
    if (digit < 0) {
      digit = value;
    } else {
      out.add((digit << 4) | value);
      digit = -1;
    }
  }
  if (digit >= 0) out.add(digit << 4);
  return Uint8List.fromList(out);
}

Uint8List ascii85Decode(Uint8List data) {
  final out = <int>[];
  final group = <int>[];
  var i = 0;

  if (data.length > 1 && data[0] == 0x3c && data[1] == 0x7e) i = 2;

  for (; i < data.length; i++) {
    final byte = data[i];
    if (byte == 0x7e) break;
    if (byte == 0x7a && group.isEmpty) {
      out.addAll(const [0, 0, 0, 0]);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.add(byte - 0x21);
    if (group.length == 5) {
      var value = 0;
      for (final digit in group) {
        value = value * 85 + digit;
      }
      out.addAll([
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
      ]);
      group.clear();
    }
  }

  if (group.length > 1) {
    final missing = 5 - group.length;
    for (var j = 0; j < missing; j++) {
      group.add(84);
    }
    var value = 0;
    for (final digit in group) {
      value = value * 85 + digit;
    }
    final bytes = [
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ];
    out.addAll(bytes.take(4 - missing));
  }
  return Uint8List.fromList(out);
}

Uint8List runLengthDecode(Uint8List data) {
  final out = <int>[];
  var i = 0;
  while (i < data.length) {
    final length = data[i++];
    if (length == 128) break;
    if (length < 128) {
      for (var j = 0; j <= length; j++) {
        out.add(i < data.length ? data[i++] : 0);
      }
    } else {
      final byte = i < data.length ? data[i++] : 0;
      for (var j = 0; j < 257 - length; j++) {
        out.add(byte);
      }
    }
  }
  return Uint8List.fromList(out);
}

Uint8List lzwDecode(Uint8List data, [int earlyChange = 1]) {
  final out = <int>[];
  final dictionary = <List<int>>[];

  void reset() {
    dictionary.clear();
    for (var i = 0; i < 256; i++) {
      dictionary.add(<int>[i]);
    }
    dictionary.add(<int>[]);
    dictionary.add(<int>[]);
  }

  reset();

  var codeWidth = 9;
  List<int>? previous;
  var bitBuffer = 0;
  var bitCount = 0;

  for (var i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 8) | data[i];
    bitCount += 8;

    while (bitCount >= codeWidth) {
      final code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;

      if (code == 256) {
        reset();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code == 257) return Uint8List.fromList(out);

      List<int> entry;
      if (code < dictionary.length && dictionary[code].isNotEmpty) {
        entry = dictionary[code];
      } else if (previous != null) {
        entry = [...previous, previous.first];
      } else {
        continue;
      }

      out.addAll(entry);
      if (previous != null) dictionary.add([...previous, entry.first]);
      previous = entry;

      final limit = dictionary.length + earlyChange;
      if (limit >= 512 && codeWidth == 9) {
        codeWidth = 10;
      } else if (limit >= 1024 && codeWidth == 10) {
        codeWidth = 11;
      } else if (limit >= 2048 && codeWidth == 11) {
        codeWidth = 12;
      }
    }
  }
  return Uint8List.fromList(out);
}
