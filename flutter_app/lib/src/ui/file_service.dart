import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../core/converter_registry.dart';

/// A file the user chose, held in memory so conversion can run on an isolate.
typedef PickedFile = ({String name, Uint8List bytes});

/// Platform plumbing for reading input files and getting Markdown back out.
///
/// Saving differs by platform on purpose: desktop gets a real "save as" dialog,
/// while iOS and Android go through the share sheet, which is how those systems
/// expect a document to leave an app.
class FileService {
  const FileService();

  Future<List<PickedFile>> pickFiles() async {
    final selection = await FilePicker.pickFiles();

    final files = <PickedFile>[];
    for (final file in selection) {
      final bytes = await _bytesOf(file);
      if (bytes == null) continue;
      files.add((name: file.name, bytes: bytes));
    }
    return files;
  }

  /// Markdown only, for the reading view. `FileType.custom` is what puts the
  /// app's own extensions in front of the user on iOS and Android.
  Future<PickedFile?> pickMarkdown() async {
    final file = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: markdownExtensions,
    );
    if (file == null) return null;
    final bytes = await _bytesOf(file);
    return bytes == null ? null : (name: file.name, bytes: bytes);
  }

  /// The picker hands back a path on most platforms and bytes on the web, so
  /// ask it for the bytes and fall back to reading the path ourselves.
  Future<Uint8List?> _bytesOf(PlatformFile file) async {
    try {
      return await file.readAsBytes();
    } catch (_) {
      final path = file.path;
      if (path == null) return null;
      try {
        return await File(path).readAsBytes();
      } catch (_) {
        return null;
      }
    }
  }

  /// Returns the destination shown to the user, or null when cancelled.
  Future<String?> save(String fileName, String markdown) async {
    final bytes = Uint8List.fromList(utf8.encode(markdown));

    if (isDesktop) {
      final saved = await FilePicker.saveFile(
        fileName: fileName,
        bytes: bytes,
        mimeType: 'text/markdown',
        type: FileType.custom,
        allowedExtensions: const ['md'],
      );
      if (saved == null) return null;

      // Windows and Linux hand back a location without writing the bytes.
      final path = saved.toFilePath();
      final file = File(path);
      if (!await file.exists() || await file.length() == 0) {
        await file.writeAsBytes(bytes, flush: true);
      }
      return path;
    }

    final directory = await getTemporaryDirectory();
    final file = File('${directory.path}/$fileName');
    await file.writeAsBytes(bytes, flush: true);
    await SharePlus.instance.share(
      ShareParams(
        files: [XFile(file.path, mimeType: 'text/markdown')],
        subject: fileName,
      ),
    );
    return file.path;
  }

  Future<void> shareText(String markdown, String subject) async {
    await SharePlus.instance.share(ShareParams(text: markdown, subject: subject));
  }

  static bool get isDesktop =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows || Platform.isLinux);

  /// Extensions the picker advertises; detection itself is content-based.
  List<String> get advertisedExtensions => supportedExtensions;
}

/// Markdown is already the output format, so a `.md` file is read rather than
/// converted — whether it was picked, shared in, or handed over by the OS.
/// Mirrors `MARKDOWN_EXTENSIONS` in `web/src/main.ts`.
const List<String> markdownExtensions = ['md', 'markdown', 'mdown', 'mkd', 'mdx'];

bool isMarkdownFileName(String name) {
  final lower = name.toLowerCase();
  return markdownExtensions.any((extension) => lower.endsWith('.$extension'));
}
