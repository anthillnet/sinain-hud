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

        // Start at chat size (bottom-right corner) so the feed is immediately visible
        let screenFrame = NSScreen.main?.visibleFrame ?? HUDConfig.fallbackScreenRect
        let windowX = screenFrame.maxX - HUDConfig.defaultChatWidth - HUDConfig.margin
        let windowY = screenFrame.minY + HUDConfig.margin

        window.setFrame(
            NSRect(x: windowX, y: windowY, width: HUDConfig.defaultChatWidth, height: HUDConfig.defaultChatHeight),
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

        // Navigation
        registerHotKey(id: 1,  keyCode: UInt32(kVK_Space),      modifiers: UInt32(cmdKey | shiftKey)) // toggle visibility
        registerHotKey(id: 3,  keyCode: UInt32(kVK_ANSI_M),     modifiers: UInt32(cmdKey | shiftKey)) // cycle state
        registerHotKey(id: 4,  keyCode: UInt32(kVK_ANSI_H),     modifiers: UInt32(cmdKey | shiftKey)) // quit
        registerHotKey(id: 19, keyCode: UInt32(kVK_ANSI_F),     modifiers: UInt32(cmdKey | shiftKey)) // toggle chat
        registerHotKey(id: 12, keyCode: UInt32(kVK_ANSI_E),     modifiers: UInt32(cmdKey | shiftKey)) // cycle tab
        registerHotKey(id: 13, keyCode: UInt32(kVK_ANSI_P),     modifiers: UInt32(cmdKey | shiftKey)) // reset position
        registerHotKey(id: 18, keyCode: UInt32(kVK_ANSI_Slash), modifiers: UInt32(cmdKey | shiftKey)) // focus input

        // Capture toggles
        registerHotKey(id: 5,  keyCode: UInt32(kVK_ANSI_T),     modifiers: UInt32(cmdKey | shiftKey)) // toggle audio capture
        registerHotKey(id: 10, keyCode: UInt32(kVK_ANSI_S),     modifiers: UInt32(cmdKey | shiftKey)) // toggle screen capture
        registerHotKey(id: 17, keyCode: UInt32(kVK_ANSI_B),     modifiers: UInt32(cmdKey | shiftKey)) // toggle traits
        registerHotKey(id: 15, keyCode: UInt32(kVK_ANSI_R),     modifiers: UInt32(cmdKey | shiftKey)) // toggle demo/privacy

        // Feed display
        registerHotKey(id: 7,  keyCode: UInt32(kVK_ANSI_A),     modifiers: UInt32(cmdKey | shiftKey)) // toggle audio feed
        registerHotKey(id: 11, keyCode: UInt32(kVK_ANSI_V),     modifiers: UInt32(cmdKey | shiftKey)) // toggle screen feed
        registerHotKey(id: 8,  keyCode: UInt32(kVK_UpArrow),    modifiers: UInt32(cmdKey | shiftKey)) // scroll up
        registerHotKey(id: 9,  keyCode: UInt32(kVK_DownArrow),  modifiers: UInt32(cmdKey | shiftKey)) // scroll down
        registerHotKey(id: 14, keyCode: UInt32(kVK_ANSI_Y),     modifiers: UInt32(cmdKey | shiftKey)) // copy message
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
        // ── Navigation ──
        case 1: // Space → toggle visibility
            let wasVisible = window.isVisible
            if wasVisible { window.orderOut(nil) } else { window.orderFront(nil) }
            hotkeyChannel?.invokeMethod("onToggleVisibility", arguments: !wasVisible)
        case 3: // M → cycle state (Eye → Controls → Chat → Eye)
            hotkeyChannel?.invokeMethod("onCycleState", arguments: nil)
        case 4: // H → quit
            hotkeyChannel?.invokeMethod("onQuit", arguments: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
        case 19: // F → toggle Eye ↔ Chat
            hotkeyChannel?.invokeMethod("onToggleChat", arguments: nil)
        case 12: // E → cycle tab (Agent ↔ Tasks)
            hotkeyChannel?.invokeMethod("onCycleTab", arguments: nil)
        case 13: // P → reset position to default
            hotkeyChannel?.invokeMethod("onResetPosition", arguments: nil)
        case 18: // / → focus command input (transition to Chat if needed)
            hotkeyChannel?.invokeMethod("onFocusInput", arguments: nil)

        // ── Capture toggles ──
        case 5: // T → toggle audio capture
            hotkeyChannel?.invokeMethod("onToggleAudio", arguments: nil)
        case 10: // S → toggle screen capture
            hotkeyChannel?.invokeMethod("onToggleScreen", arguments: nil)
        case 17: // B → toggle trait voices
            hotkeyChannel?.invokeMethod("onToggleTraits", arguments: nil)
        case 15: // R → toggle demo/privacy mode
            if #available(macOS 12.0, *) {
                let currentlyPrivate = window.sharingType == .none
                window.sharingType = currentlyPrivate ? .readOnly : .none
                hotkeyChannel?.invokeMethod("onTogglePrivacy", arguments: !currentlyPrivate)
            }

        // ── Feed display ──
        case 7: // A → toggle audio feed filter
            hotkeyChannel?.invokeMethod("onToggleAudioFeed", arguments: nil)
        case 11: // V → toggle screen feed filter
            hotkeyChannel?.invokeMethod("onToggleScreenFeed", arguments: nil)
        case 8: // Up → scroll feed up
            hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "up")
        case 9: // Down → scroll feed down
            hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "down")
        case 14: // Y → copy selected message
            hotkeyChannel?.invokeMethod("onCopyMessage", arguments: nil)

        default:
            break
        }
    }
}
