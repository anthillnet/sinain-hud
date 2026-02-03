import Cocoa
import FlutterMacOS

/// Native NSWindow control via Flutter platform channel.
/// Provides privacy mode, click-through, always-on-top, transparency, and show/hide.
class WindowControlPlugin: NSObject, FlutterPlugin {
    static let channelName = "sinain_hud/window"

    static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: channelName,
            binaryMessenger: registrar.messenger
        )
        let instance = WindowControlPlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        guard let window = NSApplication.shared.windows.first else {
            result(FlutterError(code: "NO_WINDOW",
                              message: "No window available",
                              details: nil))
            return
        }

        let args = call.arguments as? [String: Any]

        switch call.method {
        case "setPrivacyMode":
            let enabled = args?["enabled"] as? Bool ?? true
            if #available(macOS 12.0, *) {
                window.sharingType = enabled ? .none : .readOnly
            }
            result(nil)

        case "setClickThrough":
            let enabled = args?["enabled"] as? Bool ?? true
            window.ignoresMouseEvents = enabled
            result(nil)

        case "setAlwaysOnTop":
            let enabled = args?["enabled"] as? Bool ?? true
            window.level = enabled ? .floating : .normal
            result(nil)

        case "setTransparent":
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            // Make the content view layer-backed and transparent
            if let contentView = window.contentView {
                contentView.wantsLayer = true
                contentView.layer?.backgroundColor = CGColor.clear
            }
            result(nil)

        case "hideWindow":
            window.orderOut(nil)
            result(nil)

        case "showWindow":
            window.orderFront(nil)
            result(nil)

        case "setPosition":
            let top = args?["top"] as? Bool ?? false
            let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
            let windowWidth: CGFloat = 640
            let windowHeight: CGFloat = 440
            let margin: CGFloat = 16
            let windowX = screenFrame.maxX - windowWidth - margin
            let windowY = top
                ? screenFrame.maxY - windowHeight - margin
                : screenFrame.minY + margin
            window.setFrame(
                NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
                display: true
            )
            result(nil)

        default:
            result(FlutterMethodNotImplemented)
        }
    }
}
