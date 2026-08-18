import 'dart:typed_data';

import 'crypt.dart';
import 'filters.dart';
import 'lexer.dart';

/// PDF document loader.
///
/// Every `N G obj` header is scanned directly rather than trusting the
/// cross-reference table, which is wrong or truncated in a surprising share of
/// real files. Object streams are expanded afterwards, so compressed-xref PDFs
/// load through the same path. Mirrors `web/src/converters/pdf/document.ts`.
class PdfPage {
  const PdfPage({
    required this.dict,
    required this.resources,
    required this.mediaBox,
    required this.rotate,
  });

  final PdfDict dict;
  final PdfDict? resources;
  final List<double> mediaBox;
  final int rotate;
}

class _ObjectSlot {
  const _ObjectSlot(this.offset, this.gen);

  final int offset;
  final int gen;
}

class PdfDocument {
  PdfDocument._(this.bytes);

  final Uint8List bytes;

  final List<String> warnings = <String>[];
  final List<PdfPage> pages = <PdfPage>[];

  final Map<int, _ObjectSlot> _offsets = <int, _ObjectSlot>{};
  final Map<int, Object?> _cache = <int, Object?>{};
  final Set<int> _parsing = <int>{};
  final Map<int, Object?> _compressed = <int, Object?>{};
  Decryptor? _decryptor;
  PdfDict _trailer = <String, Object?>{};

  static PdfDocument parse(Uint8List bytes) {
    final doc = PdfDocument._(bytes);
    doc._scanObjects();
    doc._readTrailer();
    doc._setUpDecryption();
    doc._expandObjectStreams();
    doc._buildPages();
    return doc;
  }

  int get pageCount => pages.length;

  Map<String, String> info() {
    final meta = <String, String>{};
    final info = resolve(_trailer['Info']);
    if (info is! Map) return meta;
    final dict = info.cast<String, Object?>();

    String read(String key) {
      final value = resolve(dict[key]);
      return value is PdfString ? decodePdfTextString(value).trim() : '';
    }

    for (final entry in const [
      ['title', 'Title'],
      ['author', 'Author'],
      ['subject', 'Subject'],
      ['keywords', 'Keywords'],
      ['creator', 'Creator'],
      ['producer', 'Producer'],
    ]) {
      final value = read(entry[1]);
      if (value.isNotEmpty) meta[entry[0]] = value;
    }
    final created = read('CreationDate');
    if (created.isNotEmpty) meta['created'] = formatPdfDate(created);
    final modified = read('ModDate');
    if (modified.isNotEmpty) meta['modified'] = formatPdfDate(modified);
    return meta;
  }

  Object? resolve(Object? value) {
    var current = value;
    var guard = 0;
    while (current is PdfRef && guard++ < 64) {
      current = _getObject(current.num, current.gen);
    }
    return current;
  }

  Object? dictGet(PdfDict? dict, List<String> keys) {
    if (dict == null) return null;
    for (final key in keys) {
      if (dict.containsKey(key)) return resolve(dict[key]);
    }
    return null;
  }

  /// Fully decoded bytes for a stream object.
  Uint8List streamData(PdfStreamObject stream, [PdfRef? owner]) {
    var raw = stream.raw;
    final decryptor = _decryptor;
    if (decryptor != null && owner != null) {
      final type = dictGet(stream.dict, ['Type']);
      final isXref = type is PdfName && type.name == 'XRef';
      if (!isXref) raw = decryptor.decrypt(raw, owner.num, owner.gen);
    }
    try {
      return decodeStream(stream.dict, raw, resolve).data;
    } catch (error) {
      warnings.add('Could not decode a stream: $error');
      return Uint8List(0);
    }
  }

  void _scanObjects() {
    for (var i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] != 0x6f || bytes[i + 1] != 0x62 || bytes[i + 2] != 0x6a) continue; // "obj"
      if (i + 3 < bytes.length && isPdfRegular(bytes[i + 3])) continue;

      var j = i - 1;
      while (j >= 0 && _isSpace(bytes[j])) {
        j--;
      }
      final genEnd = j + 1;
      while (j >= 0 && _isDigit(bytes[j])) {
        j--;
      }
      final genStart = j + 1;
      if (genStart == genEnd) continue;

      while (j >= 0 && _isSpace(bytes[j])) {
        j--;
      }
      final numEnd = j + 1;
      while (j >= 0 && _isDigit(bytes[j])) {
        j--;
      }
      final numStart = j + 1;
      if (numStart == numEnd) continue;
      if (numStart > 0 && isPdfRegular(bytes[numStart - 1])) continue;

      final num = int.tryParse(latin1Of(bytes, numStart, numEnd));
      final gen = int.tryParse(latin1Of(bytes, genStart, genEnd));
      if (num == null || gen == null) continue;

      _offsets[num] = _ObjectSlot(numStart, gen);
      i += 2;
    }
  }

  Object? _getObject(int num, [int gen = 0]) {
    if (_cache.containsKey(num)) return _cache[num];

    final slot = _offsets[num];
    if (slot == null) return _compressed[num];

    if (_parsing.contains(num)) return null;
    _parsing.add(num);

    Object? value;
    try {
      value = _parseObjectAt(slot.offset, num, slot.gen);
    } catch (error) {
      warnings.add('Object $num could not be read: $error');
      value = null;
    } finally {
      _parsing.remove(num);
    }

    value ??= _compressed[num];
    _cache[num] = value;
    return value;
  }

  Object? _parseObjectAt(int offset, int expectedNum, int gen) {
    final lexer = Lexer(bytes, offset);
    final objectNumber = lexer.next();
    lexer.next(); // generation
    final keyword = lexer.next();
    if (keyword is! PdfOperator || keyword.op != 'obj') return null;
    if (objectNumber is num && objectNumber.toInt() != expectedNum) return null;

    final value = lexer.next();
    if (identical(value, endOfInput)) return null;

    lexer.skipWhitespace();
    final save = lexer.pos;
    final after = lexer.next();

    if (after is PdfOperator && after.op == 'stream' && value is Map) {
      final dict = value.cast<String, Object?>();
      var start = lexer.pos;
      if (start < bytes.length && bytes[start] == 0x0d) start++;
      if (start < bytes.length && bytes[start] == 0x0a) start++;

      final length = dictGet(dict, ['Length']);
      var end = length is num ? start + length.toInt() : -1;

      if (end < 0 || end > bytes.length || !_looksLikeEndstream(end)) {
        end = _findEndstream(start);
      }
      return PdfStreamObject(dict, Uint8List.sublistView(bytes, start, end < start ? start : end));
    }

    lexer.pos = save;
    return _decryptStrings(value, expectedNum, gen);
  }

  Object? _decryptStrings(Object? value, int num, int gen) {
    final decryptor = _decryptor;
    if (decryptor == null) return value;

    Object? walk(Object? node) {
      if (node is PdfString) return PdfString(decryptor.decrypt(node.bytes, num, gen));
      if (node is List) return node.map(walk).toList();
      if (node is Map) {
        final out = <String, Object?>{};
        node.forEach((key, entry) => out[key as String] = walk(entry));
        return out;
      }
      return node;
    }

    return walk(value);
  }

  bool _looksLikeEndstream(int end) {
    for (var i = end; i < (end + 4 < bytes.length ? end + 4 : bytes.length); i++) {
      if (_isSpace(bytes[i])) continue;
      final stop = i + 9 < bytes.length ? i + 9 : bytes.length;
      return latin1Of(bytes, i, stop) == 'endstream';
    }
    return false;
  }

  int _findEndstream(int start) {
    const target = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // endstream
    outer:
    for (var i = start; i + target.length <= bytes.length; i++) {
      for (var j = 0; j < target.length; j++) {
        if (bytes[i + j] != target[j]) continue outer;
      }
      var end = i;
      if (end > start && bytes[end - 1] == 0x0a) end--;
      if (end > start && bytes[end - 1] == 0x0d) end--;
      return end;
    }
    return bytes.length;
  }

  void _readTrailer() {
    final merged = <String, Object?>{};
    const keyword = [0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72]; // trailer

    outer:
    for (var i = 0; i + keyword.length <= bytes.length; i++) {
      for (var j = 0; j < keyword.length; j++) {
        if (bytes[i + j] != keyword[j]) continue outer;
      }
      final lexer = Lexer(bytes, i + keyword.length);
      final dict = lexer.next();
      if (dict is Map) {
        dict.forEach((key, value) => merged.putIfAbsent(key as String, () => value));
      }
    }

    if (!merged.containsKey('Root') || !merged.containsKey('Encrypt')) {
      for (final num in _offsets.keys.toList()) {
        final value = _getObject(num);
        final dict = value is PdfStreamObject
            ? value.dict
            : (value is Map ? value.cast<String, Object?>() : null);
        if (dict == null) continue;
        final type = dict['Type'];
        if (type is PdfName && type.name == 'XRef') {
          dict.forEach((key, entry) => merged.putIfAbsent(key, () => entry));
        }
      }
    }

    _trailer = merged;
  }

  void _setUpDecryption() {
    final encrypt = _trailer['Encrypt'];
    if (encrypt == null) return;

    final dict = resolve(encrypt);
    if (dict is! Map) return;

    final ids = resolve(_trailer['ID']);
    final firstId = ids is List && ids.isNotEmpty && ids.first is PdfString
        ? (ids.first as PdfString).bytes
        : Uint8List(0);

    _decryptor = Decryptor.create(dict.cast<String, Object?>(), firstId, resolve);
    // Objects parsed before the handler existed hold undecrypted strings.
    _cache.clear();
  }

  void _expandObjectStreams() {
    for (final num in _offsets.keys.toList()) {
      final value = _getObject(num);
      if (value is! PdfStreamObject) continue;
      final type = dictGet(value.dict, ['Type']);
      if (type is! PdfName || type.name != 'ObjStm') continue;

      try {
        _readObjectStream(value, PdfRef(num, _offsets[num]?.gen ?? 0));
      } catch (error) {
        warnings.add('Object stream $num could not be read: $error');
      }
    }
  }

  void _readObjectStream(PdfStreamObject stream, PdfRef owner) {
    final data = streamData(stream, owner);
    final count = dictGet(stream.dict, ['N']);
    final first = dictGet(stream.dict, ['First']);
    if (count is! num || first is! num) return;

    final header = Lexer(data, 0);
    final entries = <MapEntry<int, int>>[];
    for (var i = 0; i < count.toInt(); i++) {
      final objectNumber = header.next();
      final offset = header.next();
      if (objectNumber is! num || offset is! num) break;
      entries.add(MapEntry(objectNumber.toInt(), offset.toInt()));
    }

    for (final entry in entries) {
      if (_offsets.containsKey(entry.key)) continue;
      final lexer = Lexer(data, first.toInt() + entry.value);
      final value = lexer.next();
      if (!identical(value, endOfInput) && value is! PdfOperator) {
        _compressed[entry.key] = value;
      }
    }
  }

  void _buildPages() {
    final root = resolve(_trailer['Root']);
    final catalog = root is Map ? root.cast<String, Object?>() : _findCatalog();
    final pagesRoot = catalog == null ? null : dictGet(catalog, ['Pages']);

    if (pagesRoot is Map) {
      _walkPageTree(pagesRoot.cast<String, Object?>(), const {}, <PdfDict>{});
    }

    if (pages.isEmpty) _collectLoosePages();
  }

  PdfDict? _findCatalog() {
    for (final num in _offsets.keys.toList()) {
      final value = _getObject(num);
      if (value is! Map) continue;
      final type = value['Type'];
      if (type is PdfName && type.name == 'Catalog') return value.cast<String, Object?>();
    }
    return null;
  }

  void _walkPageTree(PdfDict node, Map<String, Object?> inherited, Set<PdfDict> visited) {
    if (visited.contains(node) || pages.length > 5000) return;
    visited.add(node);

    final resourcesValue = dictGet(node, ['Resources']);
    final mediaBoxValue = dictGet(node, ['MediaBox']);
    final rotateValue = dictGet(node, ['Rotate']);

    final context = <String, Object?>{
      'resources': resourcesValue is Map ? resourcesValue.cast<String, Object?>() : inherited['resources'],
      'mediaBox': mediaBoxValue is List
          ? mediaBoxValue.map((v) {
              final resolved = resolve(v);
              return resolved is num ? resolved.toDouble() : 0.0;
            }).toList()
          : inherited['mediaBox'],
      'rotate': rotateValue is num ? rotateValue.toInt() : inherited['rotate'],
    };

    final type = dictGet(node, ['Type']);
    final kids = dictGet(node, ['Kids']);

    if (kids is List) {
      for (final kid in kids) {
        final child = resolve(kid);
        if (child is Map) _walkPageTree(child.cast<String, Object?>(), context, visited);
      }
      return;
    }

    if (type is PdfName && type.name == 'Pages') return;
    _pushPage(node, context);
  }

  void _collectLoosePages() {
    final nums = _offsets.keys.toList()..sort();
    for (final num in nums) {
      final value = _getObject(num);
      if (value is! Map) continue;
      final dict = value.cast<String, Object?>();
      final type = dict['Type'];
      if (type is PdfName && type.name == 'Page') {
        final resources = dictGet(dict, ['Resources']);
        _pushPage(dict, {
          'resources': resources is Map ? resources.cast<String, Object?>() : null,
        });
      }
    }
  }

  void _pushPage(PdfDict dict, Map<String, Object?> context) {
    final box = context['mediaBox'];
    final mediaBox = box is List<double> && box.length == 4 ? box : const [0.0, 0.0, 612.0, 792.0];
    final rotate = context['rotate'];
    pages.add(PdfPage(
      dict: dict,
      resources: context['resources'] as PdfDict?,
      mediaBox: mediaBox,
      rotate: rotate is int ? ((rotate % 360) + 360) % 360 : 0,
    ));
  }

  /// Concatenated, decoded content streams for a page.
  Uint8List pageContent(PdfPage page) {
    final parts = <Uint8List>[];

    void add(Object? value, [PdfRef? ref]) {
      final resolved = value is PdfRef ? resolve(value) : value;
      final owner = value is PdfRef ? value : ref;
      if (resolved is PdfStreamObject) {
        parts.add(streamData(resolved, owner));
      } else if (resolved is List) {
        for (final item in resolved) {
          add(item);
        }
      }
    }

    add(page.dict['Contents']);

    if (parts.isEmpty) return Uint8List(0);
    if (parts.length == 1) return parts.first;

    final total = parts.fold<int>(0, (sum, part) => sum + part.length + 1);
    final out = Uint8List(total);
    var at = 0;
    for (final part in parts) {
      out.setRange(at, at + part.length, part);
      at += part.length;
      out[at++] = 0x0a;
    }
    return out;
  }
}

bool _isSpace(int byte) =>
    byte == 0x20 || byte == 0x0a || byte == 0x0d || byte == 0x09 || byte == 0x00 || byte == 0x0c;

bool _isDigit(int byte) => byte >= 0x30 && byte <= 0x39;

/// `D:20240115093000+02'00'` → `2024-01-15 09:30:00`.
String formatPdfDate(String value) {
  final match = RegExp(r'^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?').firstMatch(value);
  if (match == null) return value;
  final year = match.group(1)!;
  final month = match.group(2) ?? '01';
  final day = match.group(3) ?? '01';
  final hour = match.group(4);
  if (hour == null) return '$year-$month-$day';
  return '$year-$month-$day $hour:${match.group(5) ?? '00'}:${match.group(6) ?? '00'}';
}
