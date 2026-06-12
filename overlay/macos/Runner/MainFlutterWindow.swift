import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSPanel {
    override func awakeFromNib() {
        let flutterViewController = FlutterViewController()
        // The FlutterView paints an opaque background by default — clear it
        // so the eye state shows only the circular widget, not a window rect.
        flutterViewController.backgroundColor = .clear
        let windowFrame = self.frame
        self.contentViewController = flutterViewController
        self.setFrame(windowFrame, display: true)

        // Configure as a non-activating panel
        self.styleMask = [.borderless, .nonactivatingPanel, .fullSizeContentView]
        self.isFloatingPanel = true
        self.becomesKeyOnlyIfNeeded = true
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = false
        self.acceptsMouseMovedEvents = true
        self.titleVisibility = .hidden
        self.titlebarAppearsTransparent = true

        RegisterGeneratedPlugins(registry: flutterViewController)

        super.awakeFromNib()
    }

    // Allow the panel to become key when needed but don't force it
    override var canBecomeKey: Bool {
        return true
    }

    override var canBecomeMain: Bool {
        return false
    }
}
