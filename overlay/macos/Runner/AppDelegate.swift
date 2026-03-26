import Cocoa
import FlutterMacOS
import Carbon.HIToolbox

@main
class AppDelegate: FlutterAppDelegate {

    private var isVisible = true

    // Flutter method channel for sending hotkey events to Dart
    private var hotkeyChannel: FlutterMethodChannel?

    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    override func applicationWillTerminate(_ notification: Notification) {
        for ref in hotKeyRefs {
            if let ref = ref {
                UnregisterEventHotKey(ref)
            }
        }
        hotKeyRefs.removeAll()
    }

    override func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = mainFlutterWindow?.contentViewController as! FlutterViewController
        let registrar = controller.registrar(forPlugin: "WindowControlPlugin")
        WindowControlPlugin.register(with: registrar)

        hotkeyChannel = FlutterMethodChannel(
            name: "sinain_hud/hotkeys",
            binaryMessenger: controller.engine.binaryMessenger
        )

        configureWindow()
        registerHotkeys()

        super.applicationDidFinishLaunching(notification)
    }

    private func configureWindow() {
        guard let window = mainFlutterWindow else { return }

        // Frameless, transparent, non-activating
        window.styleMask = [.borderless, .fullSizeContentView]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        // Flutter handles drag — don't let NSWindow do it
        window.isMovableByWindowBackground = false

        window.collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .fullScreenAuxiliary,
            .ignoresCycle
        ]

        window.level = .floating

        // Non-activating panel — won't steal focus from other apps on click
        window.styleMask.insert(.nonactivatingPanel)

        // Always interactive — overlay is clickable in all states
        window.ignoresMouseEvents = false

        // Privacy mode (macOS 12+)
        if #available(macOS 12.0, *) {
            window.sharingType = .none
        }

        // Start as eye-sized window at bottom-right
        let screenFrame = NSScreen.main?.visibleFrame ?? HUDConfig.fallbackScreenRect
        let windowX = screenFrame.maxX - HUDConfig.eyeSize - HUDConfig.margin
        let windowY = screenFrame.minY + HUDConfig.margin

        window.setFrame(
            NSRect(x: windowX, y: windowY, width: HUDConfig.eyeSize, height: HUDConfig.eyeSize),
            display: true
        )

        if let contentView = window.contentView {
            contentView.wantsLayer = true
            contentView.layer?.backgroundColor = CGColor.clear
        }

        window.orderFront(nil)
    }

    // MARK: - Global Hotkeys (Carbon API)

    private var hotKeyRefs: [EventHotKeyRef?] = []

    private func registerHotkeys() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let userData = userData else { return OSStatus(eventNotHandledErr) }
                let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
                return delegate.handleHotKeyEvent(event!)
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            nil
        )

        // ID 1: Cmd+Shift+Space → toggle visibility (hidden state)
        registerHotKey(id: 1, keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | shiftKey))
        // ID 4: Cmd+Shift+H → quit overlay
        registerHotKey(id: 4, keyCode: UInt32(kVK_ANSI_H), modifiers: UInt32(cmdKey | shiftKey))
        // ID 19: Cmd+Shift+F → jump Eye ↔ Chat
        registerHotKey(id: 19, keyCode: UInt32(kVK_ANSI_F), modifiers: UInt32(cmdKey | shiftKey))
    }

    private func registerHotKey(id: UInt32, keyCode: UInt32, modifiers: UInt32) {
        let hotKeyID = EventHotKeyID(signature: OSType(0x5348_5544), id: id) // 'SHUD'
        var hotKeyRef: EventHotKeyRef?

        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )

        if status == noErr {
            hotKeyRefs.append(hotKeyRef)
        } else {
            NSLog("[SinainHUD] Failed to register hotkey \(id): \(status)")
        }
    }

    private func handleHotKeyEvent(_ event: EventRef) -> OSStatus {
        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            UInt32(kEventParamDirectObject),
            UInt32(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )

        guard status == noErr else { return status }

        DispatchQueue.main.async { [weak self] in
            self?.processHotKey(id: hotKeyID.id)
        }

        return noErr
    }

    private func processHotKey(id: UInt32) {
        guard let window = mainFlutterWindow else { return }

        switch id {
        case 1: // Cmd+Shift+Space → toggle visibility
            // Check actual window visibility (not a cached flag) to stay in sync
            // with Flutter-initiated hide (long-press)
            let wasVisible = window.isVisible
            if wasVisible {
                window.orderOut(nil)
            } else {
                window.orderFront(nil)
            }
            hotkeyChannel?.invokeMethod("onToggleVisibility", arguments: !wasVisible)

        case 4: // Cmd+Shift+H → quit overlay
            hotkeyChannel?.invokeMethod("onQuit", arguments: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                NSApp.terminate(nil)
            }

        case 19: // Cmd+Shift+F → jump Eye ↔ Chat
            hotkeyChannel?.invokeMethod("onToggleChat", arguments: nil)

        default:
            break
        }
    }
}
