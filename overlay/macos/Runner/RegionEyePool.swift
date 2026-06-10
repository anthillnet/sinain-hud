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
            panel.sharingType = privacyEnabled ? .none : .readOnly
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

/// Native port of the sinain eye animation (overlay/lib/ui/feed/
/// idle_animation.dart `_PulseRingPainter`): pulsing ring, drifting
/// cat-slit pupil, 8 radial spikes. Color and pace encode the state:
/// idle = green slow breath, working = orange fast breath with dilated
/// pupil, ready = bright green full dilation, failed = red.
class RegionEyeView: NSView {
    var onTap: (() -> Void)?
    var state: String = "idle" {
        didSet { needsDisplay = true }
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
        case "ready":   return CGColor(red: 0.0, green: 1.0, blue: 0.53, alpha: 1)   // 0x00FF88
        case "failed":  return CGColor(red: 1.0, green: 0.2, blue: 0.27, alpha: 1)   // 0xFF3344
        default:        return CGColor(red: 0.0, green: 1.0, blue: 0.53, alpha: 1)   // 0x00FF88
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
