import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

import 'conversion.dart';
import 'xml_query.dart';

/// Thin wrapper over `package:archive` giving the ZIP-based converters the same
/// surface as the web app's `ZipArchive`.
class DocumentArchive {
  DocumentArchive._(this._files);

  final Map<String, ArchiveFile> _files;
  final Map<String, Uint8List> _cache = <String, Uint8List>{};

  static bool isZip(Uint8List bytes) =>
      bytes.length > 4 && bytes[0] == 0x50 && bytes[1] == 0x4b;

  static DocumentArchive open(Uint8List bytes) {
    final Archive archive;
    try {
      archive = ZipDecoder().decodeBytes(bytes, verify: false);
    } catch (error) {
      throw ConversionException('This ZIP-based file could not be opened: $error');
    }
    final files = <String, ArchiveFile>{};
    for (final file in archive.files) {
      if (file.isFile) files[file.name] = file;
    }
    if (files.isEmpty) {
      throw const ConversionException('The archive contains no readable entries.');
    }
    return DocumentArchive._(files);
  }

  List<String> get names => _files.keys.toList();

  bool has(String name) => _files.containsKey(name);

  /// Entry names under a folder prefix, natural-sorted (slide2 before slide10).
  List<String> namesUnder(String prefix, [String? extension]) {
    final matches = names
        .where((name) =>
            name.startsWith(prefix) &&
            (extension == null || name.toLowerCase().endsWith(extension)))
        .toList();
    matches.sort(naturalCompare);
    return matches;
  }

  Uint8List? read(String name) {
    final cached = _cache[name];
    if (cached != null) return cached;

    final file = _files[name];
    if (file == null) return null;

    final content = file.content;
    final bytes = content is Uint8List ? content : Uint8List.fromList(content as List<int>);
    _cache[name] = bytes;
    return bytes;
  }

  String? readText(String name) {
    final data = read(name);
    if (data == null) return null;
    final stripped = data.length >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf
        ? data.sublist(3)
        : data;
    return utf8.decode(stripped, allowMalformed: true);
  }
}

int naturalCompare(String a, String b) {
  final pattern = RegExp(r'(\d+)|(\D+)');
  final ax = pattern.allMatches(a).map((m) => m.group(0)!).toList();
  final bx = pattern.allMatches(b).map((m) => m.group(0)!).toList();

  final shortest = ax.length < bx.length ? ax.length : bx.length;
  for (var i = 0; i < shortest; i++) {
    final an = int.tryParse(ax[i]);
    final bn = int.tryParse(bx[i]);
    if (an != null && bn != null) {
      if (an != bn) return an - bn;
    } else if (ax[i] != bx[i]) {
      return ax[i].compareTo(bx[i]);
    }
  }
  return ax.length - bx.length;
}

class Relationship {
  const Relationship({required this.target, required this.type, required this.external});

  final String target;
  final String type;
  final bool external;
}

Map<String, Relationship> readRelationships(DocumentArchive archive, String path) {
  final map = <String, Relationship>{};
  final root = parseRoot(archive.readText(path));
  if (root == null) return map;

  for (final rel in descendantsOf(root, 'Relationship')) {
    final id = attrOf(rel, 'Id');
    final target = attrOf(rel, 'Target');
    if (id == null || target == null) continue;
    map[id] = Relationship(
      target: target,
      type: attrOf(rel, 'Type') ?? '',
      external: (attrOf(rel, 'TargetMode') ?? '') == 'External',
    );
  }
  return map;
}

/// `word/document.xml` → `word/_rels/document.xml.rels`
String relsPathFor(String partPath) {
  final segments = partPath.split('/');
  final name = segments.removeLast();
  final dir = segments.join('/');
  return dir.isEmpty ? '_rels/$name.rels' : '$dir/_rels/$name.rels';
}
