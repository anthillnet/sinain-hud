import Cocoa
import FlutterMacOS
import Carbon.HIToolbox

@main
class AppDelegate: FlutterAppDelegate {

    // Track state for hotkey toggles
    private var isVisible = true
    private var isClickThrough = true
    private var currentModeIndex = 0
    private let modeNames = ["feed", "alert", "minimal", "hidden"]

    // Flutter method channel for sending hotkey events to Dart
    private var hotkeyChannel: FlutterMethodChannel?

    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    override func applicationDidFinishLaunching(_ notification: Notification) {
        // Register the window control plugin
        let controller = mainFlutterWindow?.contentViewController as! FlutterViewController
        let registrar = controller.registrar(forPlugin: "WindowControlPlugin")
        WindowControlPlugin.register(with: registrar)

        // Set up hotkey channel
        hotkeyChannel = FlutterMethodChannel(
            name: "sinain_hud/hotkeys",
            binaryMessenger: controller.engine.binaryMessenger
        )

        // Configure the window
        configureWindow()

        // Register global hotkeys
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
        window.isMovableByWindowBackground = false

        // Don't appear in Mission Control / Exposé
        window.collectionBehavior = [
            .canJoinAllSpaces,       // Visible on all spaces
            .stationary,             // Don't move with spaces
            .fullScreenAuxiliary,    // Allow alongside fullscreen
            .ignoresCycle            // Skip in Cmd+Tab
        ]

        // Floating level (above normal windows)
        window.level = .floating

        // Non-activating — clicking won't steal focus from other apps
        window.styleMask.insert(.nonactivatingPanel)

        // Initial click-through
        window.ignoresMouseEvents = true

        // Privacy mode (macOS 12+)
        if #available(macOS 12.0, *) {
            window.sharingType = .none
        }

        // Position: 320x220 at bottom-right corner
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
        let windowWidth: CGFloat = 320
        let windowHeight: CGFloat = 220
        let margin: CGFloat = 16

        let windowX = screenFrame.maxX - windowWidth - margin
        let windowY = screenFrame.minY + margin  // Bottom of visible area

        window.setFrame(
            NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
            display: true
        )

        // Make content view transparent
        if let contentView = window.contentView {
            contentView.wantsLayer = true
            contentView.layer?.backgroundColor = CGColor.clear
        }

        window.orderFront(nil)
    }

    // MARK: - Global Hotkeys (Carbon API)

    private var hotKeyRefs: [EventHotKeyRef?] = []

    private func registerHotkeys() {
        // Install Carbon event handler
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

        // Register hotkeys:
        // ID 1: Cmd+Shift+Space → toggle visibility
        registerHotKey(id: 1, keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | shiftKey))
        // ID 2: Cmd+Shift+C → toggle click-through
        registerHotKey(id: 2, keyCode: UInt32(kVK_ANSI_C), modifiers: UInt32(cmdKey | shiftKey))
        // ID 3: Cmd+Shift+M → cycle display mode
        registerHotKey(id: 3, keyCode: UInt32(kVK_ANSI_M), modifiers: UInt32(cmdKey | shiftKey))
        // ID 4: Cmd+Shift+H → panic hide
        registerHotKey(id: 4, keyCode: UInt32(kVK_ANSI_H), modifiers: UInt32(cmdKey | shiftKey))
        // ID 5: Cmd+Shift+T → toggle audio capture
        registerHotKey(id: 5, keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(cmdKey | shiftKey))
        // ID 6: Cmd+Shift+D → switch audio device
        registerHotKey(id: 6, keyCode: UInt32(kVK_ANSI_D), modifiers: UInt32(cmdKey | shiftKey))
        // ID 7: Cmd+Shift+A → toggle audio feed on HUD
        registerHotKey(id: 7, keyCode: UInt32(kVK_ANSI_A), modifiers: UInt32(cmdKey | shiftKey))
        // ID 8: Cmd+Shift+Up → scroll feed up
        registerHotKey(id: 8, keyCode: UInt32(kVK_UpArrow), modifiers: UInt32(cmdKey | shiftKey))
        // ID 9: Cmd+Shift+Down → scroll feed down
        registerHotKey(id: 9, keyCode: UInt32(kVK_DownArrow), modifiers: UInt32(cmdKey | shiftKey))
        // ID 10: Cmd+Shift+S → toggle screen capture pipeline
        registerHotKey(id: 10, keyCode: UInt32(kVK_ANSI_S), modifiers: UInt32(cmdKey | shiftKey))
        // ID 11: Cmd+Shift+V → toggle screen feed on HUD
        registerHotKey(id: 11, keyCode: UInt32(kVK_ANSI_V), modifiers: UInt32(cmdKey | shiftKey))
        // ID 12: Cmd+Shift+E → cycle HUD tab (Stream / Agent)
        registerHotKey(id: 12, keyCode: UInt32(kVK_ANSI_E), modifiers: UInt32(cmdKey | shiftKey))
    }

    private func registerHotKey(id: UInt32, keyCode: UInt32, modifiers: UInt32) {
        var hotKeyID = EventHotKeyID(signature: OSType(0x5348_5544), id: id) // 'SHUD'
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
            isVisible.toggle()
            if isVisible {
                window.orderFront(nil)
            } else {
                window.orderOut(nil)
            }
            hotkeyChannel?.invokeMethod("onToggleVisibility", arguments: isVisible)

        case 2: // Cmd+Shift+C → toggle click-through
            isClickThrough.toggle()
            window.ignoresMouseEvents = isClickThrough
            hotkeyChannel?.invokeMethod("onToggleClickThrough", arguments: isClickThrough)

        case 3: // Cmd+Shift+M → cycle display mode
            currentModeIndex = (currentModeIndex + 1) % modeNames.count
            hotkeyChannel?.invokeMethod("onCycleMode", arguments: modeNames[currentModeIndex])

        case 4: // Cmd+Shift+H → panic hide
            isVisible = false
            window.orderOut(nil)
            window.ignoresMouseEvents = true
            isClickThrough = true
            if #available(macOS 12.0, *) {
                window.sharingType = .none
            }
            hotkeyChannel?.invokeMethod("onPanicHide", arguments: nil)

        case 5: // Cmd+Shift+T → toggle audio capture
            hotkeyChannel?.invokeMethod("onToggleAudio", arguments: nil)

        case 6: // Cmd+Shift+D → switch audio device
            hotkeyChannel?.invokeMethod("onSwitchAudioDevice", arguments: nil)

        case 7: // Cmd+Shift+A → toggle audio feed on HUD
            hotkeyChannel?.invokeMethod("onToggleAudioFeed", arguments: nil)

        case 8: // Cmd+Shift+Up → scroll feed up
            hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "up")

        case 9: // Cmd+Shift+Down → scroll feed down
            hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "down")

        case 10: // Cmd+Shift+S → toggle screen capture pipeline
            hotkeyChannel?.invokeMethod("onToggleScreen", arguments: nil)

        case 11: // Cmd+Shift+V → toggle screen feed on HUD
            hotkeyChannel?.invokeMethod("onToggleScreenFeed", arguments: nil)

        case 12: // Cmd+Shift+E → cycle HUD tab (Stream / Agent)
            hotkeyChannel?.invokeMethod("onCycleTab", arguments: nil)

        default:
            break
        }
    }
}
