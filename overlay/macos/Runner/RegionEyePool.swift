import Cocoa
import FlutterMacOS

/// Pool of small floating NSPanels — one per detected screen region
/// (Grammarly mode). Each panel renders a 48×48 eye with a state badge and
/// forwards taps to Flutter via the window method channel ("onRegionTap").
///
/// Panels are non-activating and privacy-protected (sharingType = .none),
/// so they never steal focus and stay invisible to screen capture.
class RegionEyePool {
    static let eyeSize: CGFloat = 48

    private var panels: [String: NSPanel] = [:]
    private weak var channel: FlutterMethodChannel?

    init(channel: FlutterMethodChannel?) {
        self.channel = channel
    }

    /// Reconcile the panel set against the desired eye list.
    /// Each entry: ["id": String, "x": Double, "y": Double, "state": String]
    /// with x/y in top-left-origin screen points.
    func reconcile(_ eyes: [[String: Any]]) {
        var seen = Set<String>()
        for eye in eyes {
            guard let id = eye["id"] as? String,
                  let x = eye["x"] as? Double,
                  let y = eye["y"] as? Double else { continue }
            let state = eye["state"] as? String ?? "idle"
            seen.insert(id)

            let origin = Self.toMacOrigin(x: x, y: y)
            if let panel = panels[id] {
                panel.setFrameOrigin(origin)
                if let view = panel.contentView as? RegionEyeView {
                    view.state = state
                }
            } else {
                panels[id] = makePanel(id: id, origin: origin, state: state)
            }
        }
        for (id, panel) in panels where !seen.contains(id) {
            panel.orderOut(nil)
            panels.removeValue(forKey: id)
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
    }

    // MARK: - Private

    private static func toMacOrigin(x: Double, y: Double) -> NSPoint {
        let screenHeight = NSScreen.main?.frame.height ?? 900
        return NSPoint(x: x, y: screenHeight - y - eyeSize)
    }

    private func makePanel(id: String, origin: NSPoint, state: String) -> NSPanel {
        let frame = NSRect(x: origin.x, y: origin.y,
                           width: Self.eyeSize, height: Self.eyeSize)
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
            panel.sharingType = .none
        }

        let view = RegionEyeView(frame: NSRect(x: 0, y: 0,
                                               width: Self.eyeSize, height: Self.eyeSize))
        view.state = state
        view.onTap = { [weak self] in
            self?.channel?.invokeMethod("onRegionTap", arguments: ["id": id])
        }
        panel.contentView = view
        panel.orderFront(nil)
        return panel
    }
}

/// Native-drawn eye icon with a state badge.
/// States: idle (green), working (orange, pulsing), ready (bright green ✓),
/// failed (red).
class RegionEyeView: NSView {
    var onTap: (() -> Void)?
    var state: String = "idle" {
        didSet {
            if state == "working" { startPulse() } else { stopPulse() }
            needsDisplay = true
        }
    }

    private var pulseTimer: Timer?
    private var pulsePhase: Double = 0

    deinit { pulseTimer?.invalidate() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        onTap?()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let inset = bounds.insetBy(dx: 3, dy: 3)

        // Dark circular background
        ctx.setFillColor(CGColor(red: 0.08, green: 0.08, blue: 0.08, alpha: 0.88))
        ctx.fillEllipse(in: inset)

        // State border
        var alpha: CGFloat = 1.0
        if state == "working" {
            alpha = 0.45 + 0.55 * CGFloat(abs(sin(pulsePhase)))
        }
        ctx.setStrokeColor(borderColor.copy(alpha: alpha) ?? borderColor)
        ctx.setLineWidth(2)
        ctx.strokeEllipse(in: inset.insetBy(dx: 1, dy: 1))

        // Eye glyph
        let str = NSAttributedString(string: "👁", attributes: [
            .font: NSFont.systemFont(ofSize: 20),
        ])
        let size = str.size()
        str.draw(at: NSPoint(x: bounds.midX - size.width / 2,
                             y: bounds.midY - size.height / 2))

        // Badge dot (bottom-right) for non-idle states
        if state != "idle" {
            let badge = NSRect(x: bounds.maxX - 14, y: bounds.minY + 4, width: 10, height: 10)
            ctx.setFillColor(borderColor)
            ctx.fillEllipse(in: badge)
            if state == "ready" {
                let check = NSAttributedString(string: "✓", attributes: [
                    .font: NSFont.boldSystemFont(ofSize: 7),
                    .foregroundColor: NSColor.black,
                ])
                let cs = check.size()
                check.draw(at: NSPoint(x: badge.midX - cs.width / 2,
                                       y: badge.midY - cs.height / 2))
            }
        }
    }

    private var borderColor: CGColor {
        switch state {
        case "working": return CGColor(red: 1.0, green: 0.67, blue: 0.0, alpha: 1)
        case "ready":   return CGColor(red: 0.0, green: 1.0, blue: 0.53, alpha: 1)
        case "failed":  return CGColor(red: 1.0, green: 0.2, blue: 0.27, alpha: 1)
        default:        return CGColor(red: 0.0, green: 0.78, blue: 0.42, alpha: 1)
        }
    }

    private func startPulse() {
        guard pulseTimer == nil else { return }
        pulseTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.pulsePhase += 0.18
            self.needsDisplay = true
        }
    }

    private func stopPulse() {
        pulseTimer?.invalidate()
        pulseTimer = nil
        pulsePhase = 0
    }
}
