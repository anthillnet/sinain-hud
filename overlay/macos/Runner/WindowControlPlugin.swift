import Cocoa
import FlutterMacOS

/// Native NSWindow control via Flutter platform channel.
class WindowControlPlugin: NSObject, FlutterPlugin {
    static let channelName = "sinain_hud/window"

    /// Channel reference for invoking Dart callbacks (drag/resize complete).
    private var channel: FlutterMethodChannel?
    private var dragMonitor: Any?
    private var resizeMonitor: Any?

    /// Region eye panels (Grammarly mode) — created lazily on first use.
    private lazy var regionEyes = RegionEyePool(channel: channel)

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
            // Demo mode applies to every capture-invisible surface, not just
            // the main HUD — region eye panels follow the same toggle.
            regionEyes.setPrivacyMode(enabled: enabled)
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

        case "getScreenSize":
            let frame = NSScreen.main?.frame ?? HUDConfig.fallbackScreenRect
            result(["w": frame.size.width, "h": frame.size.height])

        case "getScreens":
            // All displays with their global Cocoa frames + id (multi-display).
            // Lets the overlay size a region's eye against the display it was
            // detected on, then place it there.
            let screens = NSScreen.screens.map { s -> [String: Any] in
                let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
                return ["id": Double(id),
                        "x": s.frame.origin.x, "y": s.frame.origin.y,
                        "w": s.frame.size.width, "h": s.frame.size.height]
            }
            result(screens)

        case "showRegionEyes":
            let eyes = args?["eyes"] as? [[String: Any]] ?? []
            regionEyes.reconcile(eyes)
            result(nil)

        case "updateRegionEye":
            let id = args?["id"] as? String ?? ""
            let state = args?["state"] as? String ?? "idle"
            regionEyes.update(id: id, state: state)
            result(nil)

        case "clearRegionEyes":
            regionEyes.clear()
            result(nil)

        case "toggleRegionPreview":
            let id = args?["id"] as? String ?? ""
            let issue = args?["issue"] as? String ?? ""
            let tip = args?["tip"] as? String ?? ""
            let hasTerminal = args?["hasTerminal"] as? Bool ?? true
            regionEyes.togglePreview(id: id, issue: issue, tip: tip, hasTerminal: hasTerminal)
            result(nil)

        case "hideRegionPreview":
            regionEyes.hidePreview()
            result(nil)

        case "confirmRegionCopy":
            // Flutter finished copying the seed → green check + auto-dismiss.
            regionEyes.confirmCopy(id: args?["id"] as? String ?? "")
            result(nil)

        case "selectRegion":
            // Screenshot-style drag-select. Resolves with the rect in
            // top-left-origin screen points, or nil on Esc/cancel.
            // Mirror the main window's demo/privacy state so the selector is
            // visible in screen recordings when demo mode is on.
            var selectorPrivate = true
            if #available(macOS 12.0, *) {
                selectorPrivate = window.sharingType == .none
            }
            // Fade the HUD out for the duration of the drag so it never
            // obscures the area being selected; restore it when the selection
            // finishes or cancels.
            let prevAlpha = window.alphaValue
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.15
                window.animator().alphaValue = 0
            }
            RegionSelector.begin(privacyEnabled: selectorPrivate) { rect, mode in
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.15
                    window.animator().alphaValue = prevAlpha
                }
                if let r = rect, let m = mode {
                    result(["x": r.origin.x, "y": r.origin.y,
                            "w": r.size.width, "h": r.size.height,
                            "screenW": NSScreen.main?.frame.width ?? 0,
                            "screenH": NSScreen.main?.frame.height ?? 0,
                            "mode": m])
                } else {
                    result(nil)
                }
            }

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

// MARK: - RegionSelector (manual ROI drag-select)

/// Full-screen selection overlay: dark tint, crosshair, drag a rectangle,
/// Esc or click-without-drag cancels. Completion delivers the rect in
/// TOP-LEFT-origin screen points (the coordinate space sinain's regions
/// use), or nil on cancel.
///
/// Capture visibility mirrors the HUD's demo/privacy mode: private by
/// default (sharingType = .none, invisible to screen capture), but visible
/// (.readOnly) when demo mode is on so the selection shows up in recordings.
class RegionSelector {
    private static var active: RegionSelector?

    private var panel: NSPanel!
    private var keyMonitor: Any?
    private var finished = false
    private let completion: (NSRect?, String?) -> Void

    static func begin(privacyEnabled: Bool, completion: @escaping (NSRect?, String?) -> Void) {
        // One selection at a time — a second request cancels into the new one.
        active?.finish(nil, nil)
        active = RegionSelector(privacyEnabled: privacyEnabled, completion: completion)
    }

    private init(privacyEnabled: Bool, completion: @escaping (NSRect?, String?) -> Void) {
        self.completion = completion
        let screen = NSScreen.main?.frame ?? HUDConfig.fallbackScreenRect
        let view = RegionSelectView(frame: NSRect(origin: .zero, size: screen.size))
        view.onDone = { [weak self] rect, mode in self?.finish(rect, mode) }

        let p = NSPanel(contentRect: screen,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .screenSaver           // above everything, incl. the HUD
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.acceptsMouseMovedEvents = true
        p.becomesKeyOnlyIfNeeded = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        if #available(macOS 12.0, *) {
            // Demo mode (privacy off) → .readOnly so the selection overlay is
            // captured in recordings; otherwise .none (invisible to capture).
            p.sharingType = privacyEnabled ? .none : .readOnly
        }
        p.contentView = view
        // The selector starts from the HUD, which is a nonactivating panel — so
        // the overlay app is usually NOT frontmost and the panel can't receive
        // key events (mouse still works; it routes by cursor position). Activate
        // the app and make the view first responder so Esc reaches keyDown.
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        p.makeFirstResponder(view)
        panel = p
        // Belt-and-suspenders: a local key monitor catches Esc even if the
        // first-responder chain isn't cooperating (consumes the event so it
        // doesn't leak to whatever is underneath).
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 { self?.finish(nil, nil); return nil }  // Esc
            return e
        }
    }

    private func finish(_ rect: NSRect?, _ mode: String?) {
        if finished { return }
        finished = true
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        panel?.orderOut(nil)
        panel = nil
        if Self.active === self { Self.active = nil }
        completion(rect, mode)
    }
}

private class RegionSelectView: NSView {
    // (rect, mode) on confirm — mode is "chat" | "term"; (nil, nil) on cancel.
    var onDone: ((NSRect?, String?) -> Void)?

    static let blue = NSColor(srgbRed: 0x33 / 255.0, green: 0x69 / 255.0, blue: 0xD6 / 255.0, alpha: 1)
    static let toolbarBg = NSColor(srgbRed: 0x2B / 255.0, green: 0x2D / 255.0, blue: 0x30 / 255.0, alpha: 1)
    static let badgeBg = NSColor(srgbRed: 0x27 / 255.0, green: 0x28 / 255.0, blue: 0x2E / 255.0, alpha: 1)

    private var start: NSPoint?
    private var current: NSPoint?
    private var frozen: NSRect?       // selection locked in on mouseUp
    private var placed = false        // true once the toolbar is shown
    private var finished = false
    private var toolbar: NSView?
    private var antTimer: Timer?
    private var antPhase: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // Marching-ant animation: advance the dash phase while a selection exists.
        antTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self = self, self.start != nil else { return }
            self.antPhase -= 2
            self.needsDisplay = true
        }
    }
    required init?(coder: NSCoder) { super.init(coder: coder) }

    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() {
        if !placed { addCursorRect(bounds, cursor: .crosshair) }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { finish(nil) }  // Esc
    }

    override func mouseDown(with event: NSEvent) {
        if placed { return }
        start = convert(event.locationInWindow, from: nil)
        current = start
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        if placed { return }
        current = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if placed { return }
        guard let s = start, let c = current else { finish(nil); return }
        let sel = rect(from: s, to: c)
        if sel.width < 12 || sel.height < 12 {  // a stray click, not a selection
            finish(nil)
            return
        }
        // Lock the selection and surface the Chat / Term toolbar under the box
        // instead of resolving immediately — the user picks the destination.
        frozen = sel
        placed = true
        addToolbar(under: sel)
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
    }

    private func rect(from a: NSPoint, to b: NSPoint) -> NSRect {
        NSRect(x: min(a.x, b.x), y: min(a.y, b.y),
               width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    /// Resolve once. mode "chat"/"term" confirms with the frozen rect (converted
    /// to top-left origin); nil cancels.
    private func finish(_ mode: String?) {
        if finished { return }
        finished = true
        antTimer?.invalidate(); antTimer = nil
        if let m = mode, let sel = frozen {
            let screenH = bounds.height
            let topLeft = NSRect(x: sel.origin.x,
                                 y: screenH - sel.origin.y - sel.height,
                                 width: sel.width, height: sel.height)
            onDone?(topLeft, m)
        } else {
            onDone?(nil, nil)
        }
    }

    @objc private func chatTapped() { finish("chat") }
    @objc private func termTapped() { finish("term") }
    @objc private func copyTapped() { finish("copy") }
    @objc private func closeTapped() { finish(nil) }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.32).setFill()
        bounds.fill()

        let sel: NSRect?
        if let f = frozen { sel = f }
        else if let s = start, let c = current { sel = rect(from: s, to: c) }
        else { sel = nil }

        guard let box = sel else {
            drawHint()
            return
        }

        // Punch a clear hole over the selection so the screen shows through.
        NSColor.clear.setFill()
        box.fill(using: .copy)
        // Faint Ring-blue tint inside, then the marching-ant border.
        RegionSelectView.blue.withAlphaComponent(0.06).setFill()
        box.fill()
        RegionSelectView.blue.setStroke()
        let path = NSBezierPath(rect: box)
        path.lineWidth = 1.5
        let dash: [CGFloat] = [6, 4]
        path.setLineDash(dash, count: dash.count, phase: antPhase)
        path.stroke()

        // Corner handles.
        drawHandle(NSPoint(x: box.minX, y: box.minY))
        drawHandle(NSPoint(x: box.maxX, y: box.minY))
        drawHandle(NSPoint(x: box.minX, y: box.maxY))
        drawHandle(NSPoint(x: box.maxX, y: box.maxY))

        drawBadge(box)
        if !placed { drawHint() }
    }

    private func drawHandle(_ p: NSPoint) {
        let r = NSRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)
        NSColor.white.setFill()
        r.fill()
        RegionSelectView.blue.setStroke()
        let bp = NSBezierPath(rect: r)
        bp.lineWidth = 1
        bp.stroke()
    }

    private func drawBadge(_ box: NSRect) {
        let text = "\(Int(box.width)) × \(Int(box.height))"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.white,
        ]
        let str = NSAttributedString(string: text, attributes: attrs)
        let ts = str.size()
        let padX: CGFloat = 6, h: CGFloat = 18
        let r = NSRect(x: box.minX, y: box.maxY + 4, width: ts.width + padX * 2, height: h)
        RegionSelectView.badgeBg.setFill()
        NSBezierPath(roundedRect: r, xRadius: 3, yRadius: 3).fill()
        str.draw(at: NSPoint(x: r.minX + padX, y: r.minY + (h - ts.height) / 2))
    }

    private func drawHint() {
        let text = "Esc to cancel · release to open a thread"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.white,
        ]
        let str = NSAttributedString(string: text, attributes: attrs)
        let ts = str.size()
        let padX: CGFloat = 12, h: CGFloat = 26
        let r = NSRect(x: 16, y: 16, width: ts.width + padX * 2, height: h)
        RegionSelectView.toolbarBg.withAlphaComponent(0.92).setFill()
        NSBezierPath(roundedRect: r, xRadius: 13, yRadius: 13).fill()
        str.draw(at: NSPoint(x: r.minX + padX, y: r.minY + (h - ts.height) / 2))
    }

    // MARK: toolbar

    private func addToolbar(under box: NSRect) {
        let pad: CGFloat = 4, h: CGFloat = 28, gap: CGFloat = 4

        // Buttons self-size to their content (icon + label + symmetric padding).
        let chat = makeTextButton(title: "Chat", symbol: "message", filled: true, action: #selector(chatTapped))
        let term = makeTextButton(title: "Term", symbol: "terminal", filled: false, action: #selector(termTapped))
        // Copy the composed seed to the clipboard — for agents we don't
        // integrate with (paste it into any tool).
        let copy = makeIconButton(symbol: "doc.on.clipboard", action: #selector(copyTapped))
        let close = makeIconButton(symbol: "xmark", action: #selector(closeTapped))

        chat.setFrameOrigin(NSPoint(x: pad, y: pad))
        term.setFrameOrigin(NSPoint(x: chat.frame.maxX + gap, y: pad))
        copy.setFrameOrigin(NSPoint(x: term.frame.maxX + gap, y: pad))
        let divX = copy.frame.maxX + gap
        let divider = NSView(frame: NSRect(x: divX, y: pad + (h - 18) / 2, width: 1, height: 18))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor(white: 1, alpha: 0.14).cgColor
        close.setFrameOrigin(NSPoint(x: divX + 1 + gap, y: pad))

        let barW = close.frame.maxX + pad
        let barH = h + pad * 2
        var bx = box.midX - barW / 2
        bx = max(8, min(bx, bounds.width - barW - 8))
        var by = box.minY - 10 - barH          // below the box…
        if by < 8 { by = box.maxY + 10 }        // …or above if there's no room.

        let bar = NSView(frame: NSRect(x: bx, y: by, width: barW, height: barH))
        bar.wantsLayer = true
        bar.layer?.backgroundColor = RegionSelectView.toolbarBg.cgColor
        bar.layer?.cornerRadius = 8
        bar.layer?.borderWidth = 1
        bar.layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor
        bar.addSubview(chat)
        bar.addSubview(term)
        bar.addSubview(copy)
        bar.addSubview(divider)
        bar.addSubview(close)
        addSubview(bar)
        toolbar = bar
    }

    private func makeTextButton(title: String, symbol: String, filled: Bool, action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.isBordered = false
        b.wantsLayer = true
        b.bezelStyle = .regularSquare
        b.layer?.cornerRadius = 4
        b.layer?.masksToBounds = true
        if filled {
            b.layer?.backgroundColor = RegionSelectView.blue.cgColor
        } else {
            b.layer?.backgroundColor = NSColor.clear.cgColor
            b.layer?.borderWidth = 1
            b.layer?.borderColor = NSColor(white: 1, alpha: 0.18).cgColor
        }
        b.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: NSColor.white,
            .font: NSFont.systemFont(ofSize: 13, weight: filled ? .medium : .regular),
        ])
        if #available(macOS 11.0, *),
           let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            b.image = img
            b.imagePosition = .imageLeading
            b.imageHugsTitle = true
            b.alignment = .center
            b.contentTintColor = .white
        }
        // Hug the content, then add symmetric horizontal padding — a fixed
        // width left the icon+label group visibly off-centre.
        b.sizeToFit()
        b.setFrameSize(NSSize(width: ceil(b.frame.width) + 16, height: 28))
        return b
    }

    private func makeIconButton(symbol: String, action: Selector) -> NSButton {
        let b = NSButton(title: "", target: self, action: action)
        b.isBordered = false
        b.wantsLayer = true
        b.contentTintColor = NSColor(srgbRed: 0xA8 / 255.0, green: 0xAD / 255.0, blue: 0xBD / 255.0, alpha: 1)
        if #available(macOS 11.0, *),
           let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Cancel") {
            b.image = img
        } else {
            b.attributedTitle = NSAttributedString(string: "✕", attributes: [
                .foregroundColor: NSColor(white: 1, alpha: 0.66),
            ])
        }
        b.setFrameSize(NSSize(width: 28, height: 28))
        return b
    }
}
