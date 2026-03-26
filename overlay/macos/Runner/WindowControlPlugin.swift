import Cocoa
import FlutterMacOS

/// Native NSWindow control via Flutter platform channel.
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

        case "setAlwaysOnTop":
            let enabled = args?["enabled"] as? Bool ?? true
            window.level = enabled ? .floating : .normal
            result(nil)

        case "setTransparent":
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
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

        case "setWindowFrame":
            let x = args?["x"] as? Double ?? 0
            let y = args?["y"] as? Double ?? 0
            let w = args?["w"] as? Double ?? Double(HUDConfig.eyeSize)
            let h = args?["h"] as? Double ?? Double(HUDConfig.eyeSize)
            window.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true)
            result(nil)

        case "getWindowFrame":
            let frame = window.frame
            result([
                "x": frame.origin.x,
                "y": frame.origin.y,
                "w": frame.size.width,
                "h": frame.size.height,
            ])

        case "moveWindowBy":
            let dx = args?["dx"] as? Double ?? 0
            let dy = args?["dy"] as? Double ?? 0
            var origin = window.frame.origin
            origin.x += CGFloat(dx)
            origin.y += CGFloat(dy)
            window.setFrameOrigin(origin)
            result(nil)

        case "resizeWindowBy":
            // Delta-based resize with anchor control.
            // anchorTop=true keeps the TOP edge fixed (macOS: adjusts origin.y so top = origin.y + height stays constant).
            // Without anchorTop, origin.y stays fixed = bottom edge stays fixed, window grows upward.
            let dw = args?["dw"] as? Double ?? 0
            let dh = args?["dh"] as? Double ?? 0
            let anchorRight = args?["anchorRight"] as? Bool ?? false
            let anchorTop = args?["anchorTop"] as? Bool ?? false

            var frame = window.frame
            let oldW = frame.size.width
            let oldH = frame.size.height
            let newW = min(max(frame.size.width + CGFloat(dw), 300), 800)
            let newH = min(max(frame.size.height + CGFloat(dh), 200), 900)

            let oldTop = frame.origin.y + frame.size.height

            // Adjust origin to keep the anchored edge fixed
            if anchorRight {
                frame.origin.x += (oldW - newW)
            }
            if anchorTop {
                // macOS: top edge = origin.y + height. To keep it fixed:
                // newOriginY = oldOriginY + oldH - newH
                frame.origin.y += (oldH - newH)
            }
            frame.size.width = newW
            frame.size.height = newH

            #if DEBUG
            NSLog("[WCP] resizeWindowBy dw=\(dw) dh=\(dh) anchorRight=\(anchorRight) anchorTop=\(anchorTop)")
            NSLog("[WCP]   old: origin=(\(window.frame.origin.x),\(window.frame.origin.y)) size=(\(oldW)x\(oldH)) top=\(oldTop)")
            NSLog("[WCP]   new: origin=(\(frame.origin.x),\(frame.origin.y)) size=(\(frame.size.width)x\(frame.size.height)) top=\(frame.origin.y + frame.size.height)")
            #endif

            window.setFrame(frame, display: true)
            result(nil)

        case "makeKeyWindow":
            // Make panel key window for text input in chat state
            window.makeKeyAndOrderFront(nil)
            if let panel = window as? NSPanel {
                panel.becomesKeyOnlyIfNeeded = false
            }
            result(nil)

        case "resignKeyWindow":
            window.resignKey()
            if let panel = window as? NSPanel {
                panel.becomesKeyOnlyIfNeeded = true
            }
            result(nil)

        case "resetToDefaultPosition":
            let screenFrame = NSScreen.main?.visibleFrame ?? HUDConfig.fallbackScreenRect
            let x = screenFrame.maxX - HUDConfig.eyeSize - HUDConfig.margin
            let y = screenFrame.minY + HUDConfig.margin
            window.setFrame(NSRect(x: x, y: y, width: HUDConfig.eyeSize, height: HUDConfig.eyeSize), display: true)
            result(nil)

        case "openFile":
            let path = args?["path"] as? String ?? ""
            if !path.isEmpty {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
            result(nil)

        default:
            result(FlutterMethodNotImplemented)
        }
    }
}
