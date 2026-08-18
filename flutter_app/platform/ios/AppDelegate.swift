import Flutter
import UIKit

/**
 Receives documents iOS and iPadOS hand to the app and forwards them to Dart.

 Reached two ways, both declared by the `CFBundleDocumentTypes` entry that
 tool/configure_platforms.sh writes into Info.plist:

 - "Open with" / "Copy to MD Converter" from the Files app, Mail, Drive or any
   share sheet, which calls `application(_:open:options:)`.
 - Launching by tapping a document, which passes the URL in the launch options.

 The Dart half is lib/src/platform/opened_files.dart.
 */
@main
@objc class AppDelegate: FlutterAppDelegate {
  private static let channelName = "md_converter/opened_files"

  /// A document the app will not try to hold in memory.
  private static let maxBytes = 200 * 1024 * 1024

  private var channel: FlutterMethodChannel?

  /// Held for the launch document, which arrives before Dart can ask for it.
  private var pending: [[String: Any]] = []

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL, let file = AppDelegate.read(url) {
      pending.append(file)
    }

    if let controller = window?.rootViewController as? FlutterViewController {
      let channel = FlutterMethodChannel(
        name: AppDelegate.channelName,
        binaryMessenger: controller.binaryMessenger
      )
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

    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard let file = AppDelegate.read(url) else { return false }

    if let channel = channel {
      channel.invokeMethod("onFilesOpened", arguments: [file])
    } else {
      pending.append(file)
    }
    return true
  }

  /// A document from another app arrives security-scoped and may live outside
  /// the sandbox, so it is read here and sent over as bytes.
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
