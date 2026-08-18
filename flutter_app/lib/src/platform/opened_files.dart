import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// A document the operating system handed to the app.
///
/// This is the "Open with" path: the user taps a `.md` (or any other supported
/// file) in Files, Finder, Drive, Mail or a file manager and picks MD
/// Converter. The platform hands over a path or the bytes themselves, and the
/// app opens it without the user ever seeing a file picker.
typedef OpenedFile = ({String name, Uint8List bytes});

/// Bridge to the per-platform document handlers.
///
/// The native halves live in the generated runners and are installed by
/// `tool/configure_platforms.sh` after `flutter create`:
///
///   Android  MainActivity forwards ACTION_VIEW and ACTION_SEND intents
///   iOS      AppDelegate forwards `application(_:open:options:)`
///   macOS    AppDelegate forwards `application(_:open:)`
///
/// All three speak the same channel, so the Dart side has one code path. When
/// the native half is missing — a platform that was never configured, or the
/// widget tests — every call degrades to "nothing was opened" rather than
/// throwing.
class OpenedFiles {
  OpenedFiles({MethodChannel? channel})
      : _channel = channel ?? const MethodChannel('md_converter/opened_files') {
    _channel.setMethodCallHandler(_handle);
  }

  static const int maxBytes = 200 * 1024 * 1024;

  final MethodChannel _channel;
  final StreamController<OpenedFile> _controller = StreamController<OpenedFile>.broadcast();

  /// Files opened while the app is already running.
  Stream<OpenedFile> get stream => _controller.stream;

  /// The file the app was launched with, if the launch came from "Open with".
  Future<List<OpenedFile>> initial() async {
    try {
      final payload = await _channel.invokeListMethod<Object?>('getInitialFiles');
      return _decodeAll(payload);
    } on MissingPluginException {
      return const [];
    } on PlatformException catch (error) {
      debugPrint('opened_files: initial() failed — ${error.message}');
      return const [];
    }
  }

  Future<Object?> _handle(MethodCall call) async {
    if (call.method != 'onFilesOpened') return null;
    for (final file in await _decodeAll(call.arguments as Object?)) {
      _controller.add(file);
    }
    return null;
  }

  Future<List<OpenedFile>> _decodeAll(Object? payload) async {
    if (payload is! List) return const [];
    final files = <OpenedFile>[];
    for (final entry in payload) {
      final file = await _decode(entry);
      if (file != null) files.add(file);
    }
    return files;
  }

  /// Each entry is `{name, path?, bytes?}` — a path where the platform can hand
  /// one over, bytes where it can only give a stream (Android content: URIs).
  Future<OpenedFile?> _decode(Object? entry) async {
    if (entry is! Map) return null;
    final path = entry['path'] as String?;
    final inlineBytes = entry['bytes'] as Uint8List?;
    final name = (entry['name'] as String?) ?? _basename(path) ?? 'document';

    if (inlineBytes != null) {
      return inlineBytes.length > maxBytes ? null : (name: name, bytes: inlineBytes);
    }
    if (path == null) return null;

    try {
      final file = File(path);
      if (await file.length() > maxBytes) return null;
      return (name: name, bytes: await file.readAsBytes());
    } catch (error) {
      debugPrint('opened_files: could not read $path — $error');
      return null;
    }
  }

  String? _basename(String? path) {
    if (path == null) return null;
    final segments = path.split(Platform.pathSeparator).where((part) => part.isNotEmpty);
    return segments.isEmpty ? null : segments.last;
  }

  void dispose() {
    _channel.setMethodCallHandler(null);
    _controller.close();
  }
}
