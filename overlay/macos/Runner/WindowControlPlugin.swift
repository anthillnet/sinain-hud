import Cocoa
import FlutterMacOS

/// Native NSWindow control via Flutter platform channel.
class WindowControlPlugin: NSObject, FlutterPlugin {
    static let channelName = "sinain_hud/window"

    /// Channel reference for invoking Dart callbacks (drag/resize complete).
    private var channel: FlutterMethodChannel?
    private var dragMonitor: Any?
    private var resizeMonitor: Any?

    static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: channelName,
            binaryMessenger: registrar.messenger
        )
        let instance = WindowControlPlugin()
        instance.channel = channel
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
            // Delegate to sinain-core via WS command — overlay is sandboxed
            result(nil)

        case "beginNativeDrag":
            beginNativeDrag(window: window)
            result(nil)

        case "beginNativeResize":
            let edge = args?["edge"] as? String ?? "right"
            beginNativeResize(window: window, edge: edge)
            result(nil)

        default:
            result(FlutterMethodNotImplemented)
        }
    }

    // MARK: - Native Drag

    private func beginNativeDrag(window: NSWindow) {
        guard dragMonitor == nil else { return } // re-entrancy guard

        let startMouse = NSEvent.mouseLocation
        let startOrigin = window.frame.origin
        // Offset from mouse to window origin — kept constant throughout drag
        let offsetX = startMouse.x - startOrigin.x
        let offsetY = startMouse.y - startOrigin.y

        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self = self else { return event }

            if event.type == .leftMouseUp {
                self.endDragMonitor(window: window)
                return event
            }

            // .leftMouseDragged
            let mouse = NSEvent.mouseLocation
            var newOrigin = NSPoint(x: mouse.x - offsetX, y: mouse.y - offsetY)
            newOrigin = self.snapToEdges(newOrigin, windowSize: window.frame.size)
            window.setFrameOrigin(newOrigin)
            return event
        }
    }

    private func endDragMonitor(window: NSWindow) {
        if let monitor = dragMonitor {
            NSEvent.removeMonitor(monitor)
            dragMonitor = nil
        }
        let frame = window.frame
        channel?.invokeMethod("onNativeDragComplete", arguments: [
            "x": frame.origin.x,
            "y": frame.origin.y,
        ])
    }

    // MARK: - Native Resize

    private func beginNativeResize(window: NSWindow, edge: String) {
        guard resizeMonitor == nil else { return }

        let startMouse = NSEvent.mouseLocation
        let startFrame = window.frame
        let initialRight = startFrame.origin.x + startFrame.size.width
        let initialTop = startFrame.origin.y + startFrame.size.height

        resizeMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self = self else { return event }

            if event.type == .leftMouseUp {
                self.endResizeMonitor(window: window)
                return event
            }

            let mouse = NSEvent.mouseLocation
            let deltaX = mouse.x - startMouse.x
            let deltaY = mouse.y - startMouse.y
            var frame = startFrame

            switch edge {
            case "right":
                // Grow right, left edge stays
                frame.size.width = Self.clampW(startFrame.size.width + deltaX)
            case "left":
                // Grow left, right edge stays
                let newW = Self.clampW(startFrame.size.width - deltaX)
                frame.origin.x = initialRight - newW
                frame.size.width = newW
            case "top":
                // macOS: drag up = +deltaY. Grow upward, bottom stays.
                frame.size.height = Self.clampH(startFrame.size.height + deltaY)
            case "bottom":
                // macOS: drag down = -deltaY. Grow downward, top stays.
                let newH = Self.clampH(startFrame.size.height - deltaY)
                frame.origin.y = initialTop - newH
                frame.size.height = newH
            default:
                break
            }

            window.setFrame(frame, display: true)
            return event
        }
    }

    private func endResizeMonitor(window: NSWindow) {
        if let monitor = resizeMonitor {
            NSEvent.removeMonitor(monitor)
            resizeMonitor = nil
        }
        let frame = window.frame
        channel?.invokeMethod("onNativeResizeComplete", arguments: [
            "w": frame.size.width,
            "h": frame.size.height,
        ])
    }

    // MARK: - Helpers

    private static func clampW(_ w: CGFloat) -> CGFloat {
        min(max(w, HUDConfig.minChatWidth), HUDConfig.maxChatWidth)
    }

    private static func clampH(_ h: CGFloat) -> CGFloat {
        min(max(h, HUDConfig.minChatHeight), HUDConfig.maxChatHeight)
    }

    private func snapToEdges(_ origin: NSPoint, windowSize: NSSize) -> NSPoint {
        let screen = NSScreen.main?.visibleFrame ?? HUDConfig.fallbackScreenRect
        let snap = HUDConfig.snapThreshold
        let margin = HUDConfig.margin
        var p = origin

        // Left edge
        if abs(p.x - screen.minX) < snap {
            p.x = screen.minX + margin
        }
        // Right edge
        if abs((p.x + windowSize.width) - screen.maxX) < snap {
            p.x = screen.maxX - windowSize.width - margin
        }
        // Bottom edge
        if abs(p.y - screen.minY) < snap {
            p.y = screen.minY + margin
        }
        // Top edge
        if abs((p.y + windowSize.height) - screen.maxY) < snap {
            p.y = screen.maxY - windowSize.height - margin
        }

        return p
    }
}
