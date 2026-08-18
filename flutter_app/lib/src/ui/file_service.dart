import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

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
    final selection = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      withData: true,
    );
    if (selection == null) return const [];

    final files = <PickedFile>[];
    for (final file in selection.files) {
      final bytes = file.bytes ?? await _readPath(file.path);
      if (bytes == null) continue;
      files.add((name: file.name, bytes: bytes));
    }
    return files;
  }

  Future<Uint8List?> _readPath(String? path) async {
    if (path == null) return null;
    try {
      return await File(path).readAsBytes();
    } catch (_) {
      return null;
    }
  }

  /// Returns the destination shown to the user, or null when cancelled.
  Future<String?> save(String fileName, String markdown) async {
    final bytes = Uint8List.fromList(utf8.encode(markdown));

    if (isDesktop) {
      final path = await FilePicker.platform.saveFile(
        fileName: fileName,
        type: FileType.custom,
        allowedExtensions: const ['md'],
        bytes: bytes,
      );
      if (path == null) return null;

      // Windows and Linux hand back a path without writing the bytes.
      final file = File(path);
      if (!await file.exists() || await file.length() == 0) {
        await file.writeAsBytes(bytes, flush: true);
      }
      return path;
    }

    final directory = await getTemporaryDirectory();
    final file = File('${directory.path}/$fileName');
    await file.writeAsBytes(bytes, flush: true);
    await Share.shareXFiles([XFile(file.path, mimeType: 'text/markdown')], subject: fileName);
    return file.path;
  }

  Future<void> shareText(String markdown, String subject) async {
    await Share.share(markdown, subject: subject);
  }

  static bool get isDesktop =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows || Platform.isLinux);

  /// Extensions the picker advertises; detection itself is content-based.
  List<String> get advertisedExtensions => supportedExtensions;
}
