import Cocoa
import FlutterMacOS

/// Manages a pool of small NSPanel windows for region highlight eye icons.
/// Each panel is a Flutter-backed window positioned at specific screen coordinates.
/// Falls back to native NSView rendering if Flutter multi-window doesn't work.
class RegionWindowPool {
    private var windows: [String: NSPanel] = [:]
    private var channel: FlutterMethodChannel?

    private let eyeSize: CGFloat = 48

    func setChannel(_ channel: FlutterMethodChannel) {
        self.channel = channel
        NSLog("[RegionPool] channel set")
    }

    // MARK: - Public API

    func create(id: String, x: CGFloat, y: CGFloat) {
        NSLog("[RegionPool] create id=\(id) x=\(x) y=\(y)")

        // Remove existing with same id
        if let existing = windows[id] {
            NSLog("[RegionPool] removing existing window for id=\(id)")
            existing.close()
            windows.removeValue(forKey: id)
        }

        // Convert to macOS coordinates (bottom-left origin)
        let screenHeight = NSScreen.main?.frame.height ?? 900
        let macY = screenHeight - y - eyeSize
        NSLog("[RegionPool] screen height=\(screenHeight), macOS y=\(macY)")

        // Create panel
        let frame = NSRect(x: x, y: macY, width: eyeSize, height: eyeSize)
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        // Configure — same as main HUD panel
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.ignoresMouseEvents = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]

        // Privacy (macOS 12+)
        if #available(macOS 12.0, *) {
            panel.sharingType = .none
            NSLog("[RegionPool] sharingType=.none set for id=\(id)")
        }

        // Create native eye view (fallback — works without Flutter)
        let eyeView = RegionEyeView(frame: NSRect(x: 0, y: 0, width: eyeSize, height: eyeSize))
        eyeView.regionId = id
        eyeView.onTap = { [weak self] regionId in
            NSLog("[RegionPool] eye tapped: id=\(regionId)")
            self?.channel?.invokeMethod("onRegionTap", arguments: ["id": regionId])
        }
        panel.contentView = eyeView

        panel.orderFront(nil)
        windows[id] = panel
        NSLog("[RegionPool] window created and shown: id=\(id), frame=\(frame), total=\(windows.count)")
    }

    func remove(id: String) {
        NSLog("[RegionPool] remove id=\(id)")
        if let panel = windows[id] {
            panel.close()
            windows.removeValue(forKey: id)
            NSLog("[RegionPool] window removed: id=\(id), remaining=\(windows.count)")
        } else {
            NSLog("[RegionPool] remove failed: no window for id=\(id)")
        }
    }

    func removeAll() {
        let count = windows.count
        NSLog("[RegionPool] removeAll (count=\(count))")
        for (id, panel) in windows {
            NSLog("[RegionPool] closing id=\(id)")
            panel.close()
        }
        windows.removeAll()
        NSLog("[RegionPool] all removed")
    }

    var count: Int { windows.count }
}

// MARK: - Native Eye View (fallback rendering)

/// A simple circular eye icon rendered natively.
/// Used as fallback when Flutter multi-window isn't available.
class RegionEyeView: NSView {
    var regionId: String = ""
    var onTap: ((String) -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let bounds = self.bounds
        let inset: CGFloat = 2

        // Dark circle background
        let bgPath = NSBezierPath(ovalIn: bounds.insetBy(dx: inset, dy: inset))
        NSColor(calibratedRed: 0.1, green: 0.1, blue: 0.1, alpha: 0.85).setFill()
        bgPath.fill()

        // Green border
        NSColor(calibratedRed: 0, green: 1, blue: 0.53, alpha: 1).setStroke()
        bgPath.lineWidth = 2
        bgPath.stroke()

        // Eye emoji
        let emoji = "👁" as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 22),
        ]
        let emojiSize = emoji.size(withAttributes: attrs)
        let emojiX = (bounds.width - emojiSize.width) / 2
        let emojiY = (bounds.height - emojiSize.height) / 2
        emoji.draw(at: NSPoint(x: emojiX, y: emojiY), withAttributes: attrs)
    }

    override func mouseDown(with event: NSEvent) {
        NSLog("[RegionEyeView] mouseDown on id=\(regionId)")
        onTap?(regionId)
    }

    // Make this view accept first mouse (click without activating)
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }
}
