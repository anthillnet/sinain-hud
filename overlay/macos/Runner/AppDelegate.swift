import Cocoa
import FlutterMacOS
import Carbon.HIToolbox

@main
class AppDelegate: FlutterAppDelegate {

    private var isVisible = true

    // Flutter method channel for sending hotkey events to Dart
    private var hotkeyChannel: FlutterMethodChannel?
    private var backendChannel: FlutterMethodChannel?
    // Fast frontmost-app-change signal → Dart → core (instant ROI restore).
    private var focusChannel: FlutterMethodChannel?
    private var lastFocusedAppName: String?

    // SEED-001 Stage 4 — bundled backend supervisor (packaged DMG only).
    private let backend = BackendLauncher()

    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    override func applicationWillTerminate(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        backend.stop()
        for ref in hotKeyRefs {
            if let ref = ref {
                UnregisterEventHotKey(ref)
            }
        }
        hotKeyRefs.removeAll()
    }

    override func applicationDidFinishLaunching(_ notification: Notification) {
        // Start the bundled backend ASAP so it's healthy by the time the
        // overlay's WebSocket tries to connect. No-op in dev builds.
        backend.start()

        let controller = mainFlutterWindow?.contentViewController as! FlutterViewController
        let registrar = controller.registrar(forPlugin: "WindowControlPlugin")
        WindowControlPlugin.register(with: registrar)

        hotkeyChannel = FlutterMethodChannel(
            name: "sinain_hud/hotkeys",
            binaryMessenger: controller.engine.binaryMessenger
        )

        // Backend control channel — lets the first-run wizard restart the
        // bundled backend after writing ~/.sinain/.env (SEED-001 Stage 5).
        backendChannel = FlutterMethodChannel(
            name: "sinain_hud/backend",
            binaryMessenger: controller.engine.binaryMessenger
        )
        backendChannel?.setMethodCallHandler { [weak self] call, result in
            guard let self = self else { result(false); return }
            switch call.method {
            // (No "isBundled" case: the first-run wizard no longer asks native
            // whether the app is bundled — that channel query raced this very
            // handler's registration and silently suppressed the wizard. The
            // wizard now gates purely on "is ~/.sinain/.env present" in Dart.)
            case "restart":
                self.backend.stop()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.backend.start()
                    result(true)
                }
            case "relaunch":
                // Used by the first-run wizard: after writing ~/.sinain/.env,
                // relaunch so the app boots through the normal startup path
                // (correct window sizing + key window) with config present.
                self.backend.stop()
                let bundlePath = Bundle.main.bundlePath
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/sh")
                task.arguments = ["-c", "sleep 1; open \"\(bundlePath)\""]
                try? task.run()
                result(true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    NSApp.terminate(nil)
                }
            case "start":
                self.backend.start(); result(true)
            case "stop":
                self.backend.stop(); result(true)
            case "quit":
                // Graceful quit: applicationWillTerminate stops the bundled
                // backend (SIGTERM → core kills its own children).
                result(true)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            case "openLog":
                result(self.openSessionLog())
            default:
                result(FlutterMethodNotImplemented)
            }
        }

        // Fast app-switch signal: NSWorkspace fires the instant the frontmost
        // app changes — ~1.5s ahead of the sense pipeline. Forward the app's
        // localizedName to Dart, which relays it to core for instant ROI
        // restore. (core matches it case-insensitively against sense's app
        // namespace; see RegionTracker.restoreForApp.)
        focusChannel = FlutterMethodChannel(
            name: "sinain_hud/focus",
            binaryMessenger: controller.engine.binaryMessenger
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(appDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )

        configureWindow()
        registerHotkeys()

        super.applicationDidFinishLaunching(notification)
    }

    @objc private func appDidActivate(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        else { return }
        // Ignore our own activations (e.g. clicking the HUD) — the overlay is
        // not a real "context" app and would only churn the signal.
        if app.bundleIdentifier == Bundle.main.bundleIdentifier { return }
        guard let name = app.localizedName, !name.isEmpty else { return }
        if name == lastFocusedAppName { return }
        lastFocusedAppName = name
        focusChannel?.invokeMethod("onAppFocus", arguments: name)
    }

    private func openSessionLog() -> [String: Any] {
        let envPath = ProcessInfo.processInfo.environment["SINAIN_SESSION_LOG"]
        let defaultURL = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".sinain/logs/backend.log")
        let logURL = (envPath?.isEmpty == false)
            ? URL(fileURLWithPath: envPath!)
            : defaultURL

        let dirURL = logURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: dirURL,
                withIntermediateDirectories: true
            )
            if !FileManager.default.fileExists(atPath: logURL.path) {
                let header = "# Sinain session log\n# No backend output has been written for this session yet.\n"
                try header.write(to: logURL, atomically: true, encoding: .utf8)
            }
        } catch {
            return [
                "opened": false,
                "path": logURL.path,
                "error": "Cannot prepare log file: \(error.localizedDescription)"
            ]
        }

        if NSWorkspace.shared.open(logURL) {
            return ["opened": true, "path": logURL.path]
        }

        NSWorkspace.shared.activateFileViewerSelecting([logURL])
        return ["opened": true, "path": logURL.path]
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

        // The overlay is mouse-driven — every action has a clickable affordance
        // except resetting a dragged-off-screen window, so P is the sole global
        // hotkey. (Quit is the overlay's button/menu; it still tears down the
        // whole stack via applicationWillTerminate → BackendLauncher.stop.)
        registerHotKey(id: 13, keyCode: UInt32(kVK_ANSI_P), modifiers: UInt32(cmdKey | shiftKey)) // reset position
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
        switch id {
        case 13: // P → reset position to default
            hotkeyChannel?.invokeMethod("onResetPosition", arguments: nil)
        default:
            break
        }
    }
}

/// Spawns and supervises the bundled sinain-core backend.
///
/// SEED-001 Stage 4. In a packaged DMG build, the overlay .app is the entry
/// point and must start the backend itself. This looks for the staged launch
/// script at `Contents/Resources/scripts/launch-backend.sh` and runs it. When
/// that script is absent — i.e. `flutter run` during development, where
/// `start.sh` already launched core — it does nothing.
final class BackendLauncher {
    private var process: Process?

    /// Path to the bundled launch script, or nil when not running from a
    /// packaged bundle (development mode).
    private var launchScriptURL: URL? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let url = resourceURL.appendingPathComponent("scripts/launch-backend.sh")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// True when this build bundles its own backend (packaged DMG).
    var isBundled: Bool { launchScriptURL != nil }

    /// Path to `stop.sh` — the canonical, supervisor-independent teardown for
    /// the whole stack. In a packaged build it's staged at
    /// `Contents/Resources/scripts/stop.sh`. In development (`flutter run`) it
    /// lives at the repo root, which we find by walking up from the running
    /// .app bundle until we hit a directory containing both `stop.sh` and
    /// `start.sh` (the repo-root marker).
    private var stopScriptURL: URL? {
        if let resourceURL = Bundle.main.resourceURL {
            let staged = resourceURL.appendingPathComponent("scripts/stop.sh")
            if FileManager.default.fileExists(atPath: staged.path) { return staged }
        }
        var dir = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("stop.sh")
            let marker = dir.appendingPathComponent("start.sh")
            if FileManager.default.fileExists(atPath: candidate.path),
               FileManager.default.fileExists(atPath: marker.path) {
                return candidate
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break } // reached filesystem root
            dir = parent
        }
        return nil
    }

    /// Run `stop.sh` detached so it outlives this app's own termination. A GUI
    /// app has no controlling terminal, so the spawned bash is orphaned to
    /// launchd and finishes the teardown (SIGTERM → core distills the session →
    /// SIGKILL stragglers) even after the overlay process exits.
    private func runStopScript() {
        guard let script = stopScriptURL else {
            NSLog("[SinainHUD] BackendLauncher: stop.sh not found — cannot tear down full stack")
            return
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [script.path]
        do {
            try task.run()
            NSLog("[SinainHUD] BackendLauncher: ran stop.sh (\(script.path))")
        } catch {
            NSLog("[SinainHUD] BackendLauncher: failed to run stop.sh: \(error)")
        }
    }

    /// Start the bundled backend if present. Safe to call when unbundled (no-op).
    func start() {
        guard let script = launchScriptURL else {
            NSLog("[SinainHUD] BackendLauncher: no bundled backend — assuming core started externally (dev mode)")
            return
        }
        guard process == nil else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [script.path]
        proc.terminationHandler = { p in
            NSLog("[SinainHUD] BackendLauncher: backend exited with status \(p.terminationStatus)")
        }
        do {
            try proc.run()
            process = proc
            NSLog("[SinainHUD] BackendLauncher: spawned bundled backend (pid \(proc.processIdentifier))")
        } catch {
            NSLog("[SinainHUD] BackendLauncher: failed to spawn backend: \(error)")
        }
    }

    /// Tear down the whole stack on app quit — not just the overlay.
    ///
    /// Two paths, unified through `stop.sh`:
    ///   • Bundled DMG: SIGTERM the launch script we spawned (its `trap cleanup`
    ///     kills core/agent/sense; core kills its own sck-capture child).
    ///   • Dev mode (`flutter run`): we spawned nothing — `start.sh` is the
    ///     supervisor — so terminating the process is a no-op and the backend
    ///     would survive. `stop.sh` kills the stack by process pattern + port
    ///     regardless of who launched it.
    ///
    /// `stop.sh` runs in both modes: it's the dev-mode fix and a harmless
    /// backstop in bundled mode (the patterns target the same processes the
    /// launch-script trap already handles).
    func stop() {
        if let proc = process, proc.isRunning {
            proc.terminate() // SIGTERM → bundled launch script's cleanup trap
            process = nil
            NSLog("[SinainHUD] BackendLauncher: sent SIGTERM to bundled backend")
        }
        runStopScript()
    }
}
