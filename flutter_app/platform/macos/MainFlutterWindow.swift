import Cocoa
import FlutterMacOS

/**
 The generated window, plus one line: the opened-files channel is registered as
 soon as the engine exists, so documents Finder hands over reach Dart.
 */
class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    // Everything above is the stock template; this is the addition.
    AppDelegate.shared.attach(messenger: flutterViewController.engine.binaryMessenger)

    super.awakeFromNib()
  }
}
