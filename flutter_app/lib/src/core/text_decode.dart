import 'dart:convert';
import 'dart:typed_data';

/// Byte → text decoding with BOM sniffing and a Windows-1252 fallback.
/// Mirrors `web/src/core/decode.ts`.
class DecodedText {
  const DecodedText(this.text, this.encoding);

  final String text;
  final String encoding;
}

const Map<int, String> _cp1252High = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

DecodedText decodeText(Uint8List bytes, [String? hintedCharset]) {
  if (bytes.isEmpty) return const DecodedText('', 'utf-8');

  if (bytes.length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) {
    return DecodedText(utf8.decode(bytes.sublist(3), allowMalformed: true), 'utf-8');
  }
  if (bytes.length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) {
    return DecodedText(_decodeUtf16(bytes.sublist(2), littleEndian: true), 'utf-16le');
  }
  if (bytes.length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) {
    return DecodedText(_decodeUtf16(bytes.sublist(2), littleEndian: false), 'utf-16be');
  }

  final charset = (hintedCharset ?? '').toLowerCase().replaceAll(RegExp('["\']'), '').trim();
  if (charset.isNotEmpty && charset != 'utf-8' && charset != 'utf8') {
    if (charset.contains('1252') || charset.contains('8859') || charset == 'ascii') {
      return DecodedText(decodeCp1252(bytes), charset);
    }
  }

  try {
    return DecodedText(const Utf8Decoder(allowMalformed: false).convert(bytes), 'utf-8');
  } on FormatException {
    return DecodedText(decodeCp1252(bytes), 'windows-1252');
  }
}

String decodeCp1252(Uint8List bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    final mapped = _cp1252High[byte];
    buffer.write(mapped ?? String.fromCharCode(byte));
  }
  return buffer.toString();
}

/// Latin-1 view of the bytes, used where byte positions must line up with
/// string indices (RTF control words, MIME boundaries, PDF keywords).
String latin1String(Uint8List bytes) => String.fromCharCodes(bytes);

String _decodeUtf16(Uint8List bytes, {required bool littleEndian}) {
  final units = <int>[];
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    units.add(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  return String.fromCharCodes(units);
}

/// Heuristic: does this payload look like text rather than a binary blob?
bool looksTextual(Uint8List bytes) {
  final limit = bytes.length < 4096 ? bytes.length : 4096;
  var control = 0;
  for (var i = 0; i < limit; i++) {
    final byte = bytes[i];
    if (byte == 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control / (limit == 0 ? 1 : limit) < 0.05;
}
