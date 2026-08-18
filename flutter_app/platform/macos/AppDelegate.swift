import Cocoa
import FlutterMacOS

/**
 Receives documents macOS hands to the app and forwards them to Dart.

 Finder's "Open With", double-clicking a `.md`, and dropping a file on the Dock
 icon all arrive as `application(_:open:)`. The channel itself is registered by
 MainFlutterWindow.swift once the Flutter engine exists; anything that lands
 before then waits in `pending`.

 The Dart half is lib/src/platform/opened_files.dart.
 */
@main
class AppDelegate: FlutterAppDelegate {
  /// A document the app will not try to hold in memory.
  private static let maxBytes = 200 * 1024 * 1024

  static let shared = OpenedFilesBridge()

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  override func application(_ application: NSApplication, open urls: [URL]) {
    let files = urls.compactMap(AppDelegate.read)
    if !files.isEmpty { AppDelegate.shared.deliver(files) }
  }

  private static func read(_ url: URL) -> [String: Any]? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }

    guard let data = try? Data(contentsOf: url), data.count <= maxBytes else { return nil }
    return [
      "name": url.lastPathComponent,
      "bytes": FlutterStandardTypedData(bytes: data),
    ]
  }
}

/// Buffers documents until the Flutter engine is up, then forwards them.
class OpenedFilesBridge {
  static let channelName = "md_converter/opened_files"

  private var channel: FlutterMethodChannel?
  private var pending: [[String: Any]] = []

  /// Called from MainFlutterWindow once the engine exists.
  func attach(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: OpenedFilesBridge.channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "getInitialFiles" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(self?.pending ?? [])
      self?.pending = []
    }
    self.channel = channel
  }

  func deliver(_ files: [[String: Any]]) {
    if let channel = channel {
      channel.invokeMethod("onFilesOpened", arguments: files)
    } else {
      pending.append(contentsOf: files)
    }
  }
}
