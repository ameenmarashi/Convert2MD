import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// The documents this app holds on the device, as real files on disk.
///
/// They live in the app's own Documents directory, which is deliberate: with
/// `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` set — both
/// written by `tool/configure_platforms.sh` — iOS and iPadOS show that folder
/// in the **Files** app under *On My iPhone/iPad → MD Converter*. So a document
/// started here is not locked inside the app: it is a `.md` file the user can
/// see, copy, move to iCloud Drive, or open in anything else.
///
/// Mirrors `web/src/core/library.ts`, which has to keep its documents in
/// browser storage because a web app on iOS gets no folder at all.
class DocumentLibrary {
  const DocumentLibrary();

  static const List<String> _extensions = ['md', 'markdown', 'mdown', 'mkd', 'mdx'];

  /// Characters a file system refuses, and the control range. Written with
  /// escapes rather than literal bytes so the source stays plain text.
  static final RegExp _unsafeInName = RegExp('[/\\\\<>:"|?*\\u0000-\\u001f]');

  Future<Directory> directory() async {
    final base = await getApplicationDocumentsDirectory();
    // A folder of its own, so the app's documents are not mixed in with
    // whatever else the platform keeps in there.
    final folder = Directory('${base.path}${Platform.pathSeparator}Documents');
    if (!await folder.exists()) await folder.create(recursive: true);
    return folder;
  }

  /// Newest first — the one last worked on is the one wanted.
  Future<List<DocumentInfo>> list() async {
    final folder = await directory();
    final documents = <DocumentInfo>[];

    await for (final entity in folder.list()) {
      if (entity is! File) continue;
      final name = _basename(entity.path);
      if (!_isMarkdown(name)) continue;
      try {
        final stat = await entity.stat();
        documents.add(DocumentInfo(
          name: name,
          path: entity.path,
          updated: stat.modified,
          bytes: stat.size,
        ));
      } catch (_) {
        // A file that vanished between listing and stat is simply not listed.
      }
    }

    documents.sort((a, b) => b.updated.compareTo(a.updated));
    return documents;
  }

  Future<String?> read(String path) async {
    try {
      return await File(path).readAsString();
    } catch (_) {
      return null;
    }
  }

  /// A new document opens with its own title already written, so the first
  /// thing a beginner sees in the preview is a heading appearing from `# `.
  Future<DocumentInfo> create([String? name]) async {
    final folder = await directory();
    final finalName = await _uniqueName(folder, name ?? 'Untitled');
    final title = finalName.replaceFirst(RegExp(r'\.md$', caseSensitive: false), '');
    return save(folder.path, finalName, '# $title\n\n');
  }

  /// Adds a document that came from somewhere else, keeping its name.
  Future<DocumentInfo> import(String name, String markdown) async {
    final folder = await directory();
    return save(folder.path, await _uniqueName(folder, name), markdown);
  }

  Future<DocumentInfo> save(String folderPath, String name, String markdown) async {
    final file = File('$folderPath${Platform.pathSeparator}$name');
    await file.writeAsString(markdown, flush: true);
    final stat = await file.stat();
    return DocumentInfo(name: name, path: file.path, updated: stat.modified, bytes: stat.size);
  }

  Future<DocumentInfo> saveAt(String path, String markdown) async {
    final file = File(path);
    await file.writeAsString(markdown, flush: true);
    final stat = await file.stat();
    return DocumentInfo(name: _basename(path), path: path, updated: stat.modified, bytes: stat.size);
  }

  /// Returns the document under its new name, which may have been adjusted to
  /// avoid overwriting one that was already there.
  Future<DocumentInfo?> rename(String path, String name) async {
    final file = File(path);
    if (!await file.exists()) return null;

    final folder = await directory();
    final finalName = await _uniqueName(folder, name, except: path);
    final target = '${folder.path}${Platform.pathSeparator}$finalName';
    if (target == path) {
      final stat = await file.stat();
      return DocumentInfo(name: finalName, path: path, updated: stat.modified, bytes: stat.size);
    }

    final moved = await file.rename(target);
    final stat = await moved.stat();
    return DocumentInfo(name: finalName, path: moved.path, updated: stat.modified, bytes: stat.size);
  }

  Future<void> delete(String path) async {
    try {
      await File(path).delete();
    } catch (_) {
      // Already gone, which is the outcome that was wanted.
    }
  }

  /* ---------------------------------------------------------------- names */

  /// `.md` on the end, and only the characters a file system will take.
  /// Spaces and hyphens stay: they are most of what people name things with.
  static String normaliseName(String name) {
    final cleaned = name.trim().replaceAll(_unsafeInName, '').trim();
    final trimmed = cleaned.isEmpty
        ? 'Untitled'
        : cleaned.substring(0, cleaned.length > 120 ? 120 : cleaned.length);
    return _isMarkdown(trimmed) ? trimmed : '$trimmed.md';
  }

  Future<String> _uniqueName(Directory folder, String name, {String? except}) async {
    final wanted = normaliseName(name);
    final taken = <String>{};

    await for (final entity in folder.list()) {
      if (entity is! File || entity.path == except) continue;
      taken.add(_basename(entity.path).toLowerCase());
    }
    if (!taken.contains(wanted.toLowerCase())) return wanted;

    final stem = wanted.replaceFirst(RegExp(r'\.md$', caseSensitive: false), '');
    for (var counter = 2; counter < 1000; counter++) {
      final candidate = '$stem $counter.md';
      if (!taken.contains(candidate.toLowerCase())) return candidate;
    }
    return '$stem ${DateTime.now().millisecondsSinceEpoch}.md';
  }

  static bool _isMarkdown(String name) {
    final lower = name.toLowerCase();
    return _extensions.any((extension) => lower.endsWith('.$extension'));
  }

  static String _basename(String path) {
    final parts = path.split(Platform.pathSeparator).where((part) => part.isNotEmpty);
    return parts.isEmpty ? path : parts.last;
  }
}

/// One document on disk, as the listing needs to know it.
class DocumentInfo {
  const DocumentInfo({
    required this.name,
    required this.path,
    required this.updated,
    required this.bytes,
  });

  final String name;
  final String path;
  final DateTime updated;
  final int bytes;
}
