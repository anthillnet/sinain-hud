import Cocoa
import FlutterMacOS

/// Pool of small floating NSPanels — one per detected screen region
/// (Grammarly mode). Each panel renders a 48×48 eye with a state badge and
/// forwards taps to Flutter via the window method channel ("onRegionTap").
///
/// Panels are non-activating and privacy-protected (sharingType = .none),
/// so they never steal focus and stay invisible to screen capture.
class RegionEyePool {
    static let eyeSize: CGFloat = 24

    private var panels: [String: NSPanel] = [:]
    private var previewPanel: NSPanel?
    private var previewId: String?
    private weak var channel: FlutterMethodChannel?

    /// Mirrors the main HUD's privacy mode: true → invisible to screen
    /// capture; false (demo mode) → visible so recordings show the eyes.
    private var privacyEnabled = true

    init(channel: FlutterMethodChannel?) {
        self.channel = channel
    }

    /// Apply privacy mode to all current and future eye panels — wired to
    /// the same demo-mode toggle as the main HUD window.
    func setPrivacyMode(enabled: Bool) {
        privacyEnabled = enabled
        if #available(macOS 12.0, *) {
            for (_, panel) in panels {
                panel.sharingType = enabled ? .none : .readOnly
            }
        }
    }

    /// Reconcile the panel set against the desired eye list.
    /// Each entry: ["id": String, "x": Double, "y": Double, "state": String]
    /// plus optional "size" (points) and "accent" (ARGB int) from the HUD's
    /// display settings. x/y in top-left-origin screen points.
    func reconcile(_ eyes: [[String: Any]]) {
        var seen = Set<String>()
        for eye in eyes {
            guard let id = eye["id"] as? String,
                  let x = eye["x"] as? Double,
                  let y = eye["y"] as? Double else { continue }
            let state = eye["state"] as? String ?? "idle"
            let size = eye["size"] as? Double ?? Double(Self.eyeSize)
            let accent = (eye["accent"] as? NSNumber).map { Self.argbToColor($0.int64Value) }
            let display = (eye["display"] as? NSNumber)?.uint32Value ?? 0
            seen.insert(id)

            let origin = Self.toMacOrigin(x: x, y: y, size: size, display: display)
            if let panel = panels[id] {
                panel.setFrame(NSRect(x: origin.x, y: origin.y, width: size, height: size), display: true)
                if let view = panel.contentView as? RegionEyeView {
                    view.state = state
                    if let accent = accent { view.accentColor = accent }
                }
            } else {
                panels[id] = makePanel(id: id, origin: origin, state: state, size: size, accent: accent)
            }
        }
        for (id, panel) in panels where !seen.contains(id) {
            panel.orderOut(nil)
            panels.removeValue(forKey: id)
            if id == previewId { hidePreview() }
        }
    }

    func update(id: String, state: String) {
        guard let view = panels[id]?.contentView as? RegionEyeView else { return }
        view.state = state
    }

    func clear() {
        for (_, panel) in panels {
            panel.orderOut(nil)
        }
        panels.removeAll()
        hidePreview()
    }

    /// Toggle the suggestion card next to the eye [id] — single-tap surfaces
    /// the detected issue + tip AND the Chat / Term choice right at the ROI (no
    /// HUD needed). Button taps fire back to Flutter via "onRegionCardAction"
    /// ({id, action: "chat"|"term"}); ✕ just dismisses. Tapping the same eye
    /// again (or its eye disappearing) hides it.
    func togglePreview(id: String, issue: String, tip: String, hasTerminal: Bool) {
        if previewId == id { hidePreview(); return }
        guard let eye = panels[id] else { hidePreview(); return }
        hidePreview()

        let w: CGFloat = 360
        let card = RegionCardView(width: w, issue: issue, tip: tip, hasTerminal: hasTerminal)
        let h = card.frame.height
        card.onChat = { [weak self] in
            self?.channel?.invokeMethod("onRegionCardAction", arguments: ["id": id, "action": "chat"])
            self?.hidePreview()
        }
        card.onTerm = { [weak self] in
            self?.channel?.invokeMethod("onRegionCardAction", arguments: ["id": id, "action": "term"])
            self?.hidePreview()
        }
        card.onCopy = { [weak self, weak card] in
            // Dim the icon and KEEP the card up; Flutter copies the seed, then
            // calls confirmCopy → green check → auto-dismiss. (Other actions
            // dismiss immediately; copy shows completion in place.)
            card?.copyLoading()
            self?.channel?.invokeMethod("onRegionCardAction", arguments: ["id": id, "action": "copy"])
        }
        card.onClose = { [weak self] in self?.hidePreview() }

        // Below the eye, left-aligned with it, clamped to the eye's screen.
        let ef = eye.frame
        let scr = eye.screen?.frame ?? NSScreen.main?.frame ?? .zero
        var x = ef.minX
        var y = ef.minY - h - 4
        if y < scr.minY + 4 { y = ef.maxY + 4 } // flip above if no room below
        x = max(scr.minX + 4, min(x, scr.maxX - w - 4))

        let panel = NSPanel(contentRect: NSRect(x: x, y: y, width: w, height: h),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = false   // the card's buttons are interactive
        if #available(macOS 12.0, *) {
            panel.sharingType = privacyEnabled ? .none : .readOnly
        }
        panel.contentView = card
        panel.orderFront(nil)
        previewPanel = panel
        previewId = id
    }

    func hidePreview() {
        previewPanel?.orderOut(nil)
        previewPanel = nil
        previewId = nil
    }

    /// Flutter finished copying this region's seed → flash a green check on the
    /// card's copy icon, then auto-dismiss. No-op if the card already closed.
    func confirmCopy(id: String) {
        guard id == previewId,
              let card = previewPanel?.contentView as? RegionCardView else { return }
        card.copyDone()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            if self?.previewId == id { self?.hidePreview() }
        }
    }

    // MARK: - Private

    /// Map a top-left-origin point WITHIN a display to a global Cocoa
    /// (bottom-left-origin) origin on that display. x/y are relative to the
    /// display's own top-left; the display's global frame supplies the offset
    /// and the flip — so an eye lands on the correct screen in a multi-display
    /// layout. display==0 (or unknown) falls back to the main display, which
    /// preserves the original single-display behavior exactly.
    private static func toMacOrigin(x: Double, y: Double, size: Double, display: UInt32) -> NSPoint {
        let f = screenFor(display).frame
        return NSPoint(x: f.minX + x, y: f.minY + (f.height - y - size))
    }

    private static func screenFor(_ display: UInt32) -> NSScreen {
        if display != 0 {
            for s in NSScreen.screens {
                if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                   n.uint32Value == display {
                    return s
                }
            }
        }
        // display == 0 (or unmatched) means the capture source didn't report a
        // display id — the CoreGraphics fallback backend, which always captures
        // the PRIMARY display (CGMainDisplayID). Fall back to the primary (the
        // screen at global origin), NOT NSScreen.main: NSScreen.main is the
        // *focused* screen, which flips to a second monitor when its window has
        // key focus and would put primary-display ROIs on the wrong screen.
        // This also matches the Dart side, which scales against the primary.
        return NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
    }

    private static func argbToColor(_ argb: Int64) -> CGColor {
        return CGColor(
            red: CGFloat((argb >> 16) & 0xFF) / 255.0,
            green: CGFloat((argb >> 8) & 0xFF) / 255.0,
            blue: CGFloat(argb & 0xFF) / 255.0,
            alpha: 1
        )
    }

    private func makePanel(id: String, origin: NSPoint, state: String, size: Double, accent: CGColor?) -> NSPanel {
        let frame = NSRect(x: origin.x, y: origin.y,
                           width: size, height: size)
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        if #available(macOS 12.0, *) {
            panel.sharingType = privacyEnabled ? .none : .readOnly
        }

        let view = RegionEyeView(frame: NSRect(x: 0, y: 0,
                                               width: size, height: size))
        view.state = state
        if let accent = accent { view.accentColor = accent }
        view.onTap = { [weak self] in
            self?.channel?.invokeMethod("onRegionTap", arguments: ["id": id])
        }
        panel.contentView = view
        panel.orderFront(nil)
        return panel
    }
}

/// Native port of the sinain eye animation (overlay/lib/ui/feed/
/// idle_animation.dart `_PulseRingPainter`): pulsing ring, drifting
/// cat-slit pupil, 8 radial spikes. Color and pace encode the state:
/// idle = green slow breath, working = orange fast breath with dilated
/// pupil, ready = bright green full dilation, failed = red.
class RegionEyeView: NSView {
    var onTap: (() -> Void)?
    /// HUD accent color — drives idle/ready tint (working/failed keep their
    /// semantic orange/red).
    var accentColor: CGColor = CGColor(red: 0.0, green: 1.0, blue: 0.53, alpha: 1) {
        didSet { needsDisplay = true }
    }
    var state: String = "idle" {
        didSet {
            // Pending = optimistically restored on app re-entry, not yet
            // confirmed by the analyzer — render it faded so it reads as
            // tentative until it solidifies (or quietly disappears).
            alphaValue = state == "pending" ? 0.45 : 1.0
            needsDisplay = true
        }
    }

    private var timer: Timer?
    private var elapsed: Double = 0
    private static let frameInterval = 1.0 / 20.0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // The sinain eye always breathes — same as the HUD idle animation
        timer = Timer.scheduledTimer(withTimeInterval: Self.frameInterval, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.elapsed += Self.frameInterval
            self.needsDisplay = true
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    deinit { timer?.invalidate() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        onTap?()
    }

    // Triangle wave 0→1→0 over the cycle, like repeat(reverse: true)
    private var t: CGFloat {
        let cycle = state == "working" ? 1.4 : 4.0
        let phase = (elapsed / cycle).truncatingRemainder(dividingBy: 2.0)
        return CGFloat(phase < 1.0 ? phase : 2.0 - phase)
    }

    private var color: CGColor {
        switch state {
        case "working": return CGColor(red: 1.0, green: 0.67, blue: 0.0, alpha: 1)   // 0xFFAA00
        case "failed":  return CGColor(red: 1.0, green: 0.2, blue: 0.27, alpha: 1)   // 0xFF3344
        default:        return accentColor                                            // idle/ready
        }
    }

    // pupilDilation mirrors the HUD eye semantics: working = thinking (0.3),
    // ready = attention (1.0), idle/failed = slit (0.0)
    private var pupilDilation: CGFloat {
        switch state {
        case "working": return 0.3
        case "ready":   return 1.0
        default:        return 0.0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let t = self.t
        let w = bounds.width
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let baseRadius = w * 0.325
        let radius = baseRadius + t * (w * 0.075)
        // Brighter range than the HUD idle (0.30–0.55) — these are small
        let alpha = 0.55 + t * (0.95 - 0.55)
        let c = color

        // Soft dark disc so the eye reads on any background
        ctx.setFillColor(CGColor(red: 0.05, green: 0.05, blue: 0.05, alpha: 0.55))
        ctx.fillEllipse(in: bounds.insetBy(dx: 1, dy: 1))

        // Pulsing ring
        ctx.setStrokeColor(c.copy(alpha: alpha) ?? c)
        ctx.setLineWidth(2)
        ctx.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius,
                                     width: radius * 2, height: radius * 2))

        // Cat-slit pupil — drifts lazily inside the ring
        let driftX = sin(t * .pi * 0.7) * radius * 0.18
        let driftY = cos(t * .pi * 1.1) * radius * 0.12
        let pupil = CGPoint(x: center.x + driftX, y: center.y + driftY)
        let slitHalfHeight = radius * 0.55
        let baseSlitWidth = 1.8 + t * 2.4   // scaled from 80px → 48px proportions
        let dilatedWidth = slitHalfHeight * 0.8
        let slitHalfWidth = baseSlitWidth + (dilatedWidth - baseSlitWidth) * pupilDilation

        let path = CGMutablePath()
        path.move(to: CGPoint(x: pupil.x, y: pupil.y - slitHalfHeight))
        path.addQuadCurve(to: CGPoint(x: pupil.x, y: pupil.y + slitHalfHeight),
                          control: CGPoint(x: pupil.x + slitHalfWidth, y: pupil.y))
        path.addQuadCurve(to: CGPoint(x: pupil.x, y: pupil.y - slitHalfHeight),
                          control: CGPoint(x: pupil.x - slitHalfWidth, y: pupil.y))
        path.closeSubpath()
        ctx.setFillColor(c.copy(alpha: alpha * 0.8) ?? c)
        ctx.addPath(path)
        ctx.fillPath()

        // Radial spike lines
        ctx.setStrokeColor(c.copy(alpha: alpha * 0.5) ?? c)
        ctx.setLineWidth(1.2)
        for i in 0..<8 {
            let angle = CGFloat(i) * .pi / 4
            let phase = sin(t * .pi + CGFloat(i) * 0.4)
            let lineLength = 1.8 + abs(phase) * 4.2
            let start = CGPoint(x: center.x + cos(angle) * radius,
                                y: center.y + sin(angle) * radius)
            let end = CGPoint(x: center.x + cos(angle) * (radius + lineLength),
                              y: center.y + sin(angle) * (radius + lineLength))
            ctx.move(to: start)
            ctx.addLine(to: end)
            ctx.strokePath()
        }
    }
}

/// The detected-ROI suggestion card (Overlay UX Drafts · D2), rendered natively
/// in the floating preview panel next to the eye: issue + tip, then a blue
/// Chat / outline Term / ✕ row. Button taps invoke the closures, which the
/// pool forwards to Flutter.
class RegionCardView: NSView {
    var onChat: (() -> Void)?
    var onTerm: (() -> Void)?
    var onCopy: (() -> Void)?
    var onClose: (() -> Void)?
    private var copyButton: NSButton?

    static let cardBg = NSColor(srgbRed: 0x2B / 255.0, green: 0x2D / 255.0, blue: 0x30 / 255.0, alpha: 1)
    static let blue = NSColor(srgbRed: 0x33 / 255.0, green: 0x69 / 255.0, blue: 0xD6 / 255.0, alpha: 1)
    static let green = NSColor(srgbRed: 0x1F / 255.0, green: 0x80 / 255.0, blue: 0x39 / 255.0, alpha: 1)
    static let muted = NSColor(srgbRed: 0xA8 / 255.0, green: 0xAD / 255.0, blue: 0xBD / 255.0, alpha: 1)

    /// Copy tapped → dim the icon while the seed is built/fetched.
    func copyLoading() {
        copyButton?.isEnabled = false
        copyButton?.animator().alphaValue = 0.35
    }

    /// Copy finished → swap the icon for a green checkmark.
    func copyDone() {
        guard let b = copyButton else { return }
        b.alphaValue = 1
        b.contentTintColor = RegionCardView.green
        if #available(macOS 11.0, *),
           let img = NSImage(systemSymbolName: "checkmark", accessibilityDescription: "Copied") {
            b.image = img
        }
    }

    init(width: CGFloat, issue: String, tip: String, hasTerminal: Bool) {
        let pad: CGFloat = 12
        let contentW = width - pad * 2
        let issueLabel = RegionCardView.makeLabel(issue.isEmpty ? "Region" : issue,
                                                  size: 13, weight: .semibold,
                                                  color: .white, maxW: contentW, maxLines: 5)
        let hasTip = !tip.isEmpty
        let tipLabel = RegionCardView.makeLabel(tip, size: 12, weight: .regular,
                                                color: RegionCardView.muted, maxW: contentW, maxLines: 8)
        let issueH = issueLabel.fittingSize.height
        let tipH = hasTip ? tipLabel.fittingSize.height : 0
        let gap: CGFloat = hasTip ? 4 : 0
        let btnRowH: CGFloat = 28
        let totalH = pad + issueH + gap + tipH + 12 + btnRowH + pad

        super.init(frame: NSRect(x: 0, y: 0, width: width, height: totalH))
        wantsLayer = true
        layer?.backgroundColor = RegionCardView.cardBg.cgColor
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(srgbRed: 0x1F / 255.0, green: 0x80 / 255.0,
                                     blue: 0x39 / 255.0, alpha: 0.45).cgColor

        // Bottom-left origin: buttons at the bottom, text stacked above.
        let btnY = pad
        let tipY = btnY + btnRowH + 12
        let issueY = tipY + tipH + gap
        issueLabel.frame = NSRect(x: pad, y: issueY, width: contentW, height: issueH)
        addSubview(issueLabel)
        if hasTip {
            tipLabel.frame = NSRect(x: pad, y: tipY, width: contentW, height: tipH)
            addSubview(tipLabel)
        }

        let chat = makeTextButton(title: "Chat", symbol: "message", filled: true, action: #selector(chatTapped))
        chat.setFrameOrigin(NSPoint(x: pad, y: btnY))
        addSubview(chat)
        var trailingX = chat.frame.maxX
        if hasTerminal {
            let term = makeTextButton(title: "Term", symbol: "terminal", filled: false, action: #selector(termTapped))
            term.setFrameOrigin(NSPoint(x: trailingX + 4, y: btnY))
            addSubview(term)
            trailingX = term.frame.maxX
        }
        // Copy the composed seed to the clipboard — for agents we don't
        // integrate with (paste it into any tool).
        let copy = makeIconButton(symbol: "doc.on.clipboard", action: #selector(copyTapped))
        copy.setFrameOrigin(NSPoint(x: trailingX + 4, y: btnY))
        addSubview(copy)
        copyButton = copy
        let close = makeIconButton(symbol: "xmark", action: #selector(closeTapped))
        close.setFrameOrigin(NSPoint(x: width - pad - 28, y: btnY))
        addSubview(close)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    @objc private func chatTapped() { onChat?() }
    @objc private func termTapped() { onTerm?() }
    @objc private func copyTapped() { onCopy?() }
    @objc private func closeTapped() { onClose?() }

    private static func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight,
                                  color: NSColor, maxW: CGFloat, maxLines: Int = 3) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = NSFont.systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.backgroundColor = .clear
        l.isBezeled = false
        l.isEditable = false
        l.isSelectable = false
        l.drawsBackground = false
        l.maximumNumberOfLines = maxLines
        // Word-wrap up to maxLines, then ellipsize the last line if it still
        // overflows. .byTruncatingTail here would force a SINGLE truncated line
        // (no wrapping) — the cause of long tips being cut off on one line.
        l.lineBreakMode = .byWordWrapping
        l.cell?.truncatesLastVisibleLine = true
        l.preferredMaxLayoutWidth = maxW
        return l
    }

    private func makeTextButton(title: String, symbol: String, filled: Bool, action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.isBordered = false
        b.wantsLayer = true
        b.bezelStyle = .regularSquare
        b.layer?.cornerRadius = 4
        b.layer?.masksToBounds = true
        if filled {
            b.layer?.backgroundColor = RegionCardView.blue.cgColor
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
        b.contentTintColor = RegionCardView.muted
        if #available(macOS 11.0, *),
           let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Dismiss") {
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
