import Cocoa
import FlutterMacOS
import ScreenCaptureKit

// MARK: - FlutterPlugin

@available(macOS 14.0, *)
class ScreenCapturePlugin: NSObject, FlutterPlugin {
    private let engine = CaptureEngine.shared

    static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: "sinain_hud/screen_capture",
            binaryMessenger: registrar.messenger
        )
        let instance = ScreenCapturePlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "showPicker":
            engine.showPicker()
            result(nil)
        case "startCapture":
            engine.startCapture { error in
                if let error = error {
                    result(FlutterError(code: "CAPTURE_ERROR", message: error.localizedDescription, details: nil))
                } else {
                    result(nil)
                }
            }
        case "stopCapture":
            engine.stopCapture()
            result(nil)
        case "isCapturing":
            result(engine.isCapturing)
        case "isAvailable":
            result(true)
        // New: adaptive FPS control
        case "setAdaptiveFPS":
            if let args = call.arguments as? [String: Any],
               let enabled = args["enabled"] as? Bool {
                engine.setAdaptiveFPS(enabled: enabled)
            }
            result(nil)
        case "setFPS":
            if let args = call.arguments as? [String: Any],
               let fps = args["fps"] as? Double {
                engine.setFPS(fps)
            }
            result(nil)
        case "triggerBurst":
            engine.triggerBurst(count: 3)
            result(nil)
        case "getStats":
            result(engine.getStats())
        default:
            result(FlutterMethodNotImplemented)
        }
    }
}

// MARK: - Activity Level

enum ActivityLevel: Int {
    case idle = 0      // >5s no activity → 0.5 FPS
    case reading = 1   // Minimal activity → 2 FPS
    case typing = 2    // Keyboard activity → 5 FPS
    case scrolling = 3 // Fast motion → 15 FPS
    case burst = 4     // Event triggered → immediate + 3 frames

    var fps: Double {
        switch self {
        case .idle: return 0.5
        case .reading: return 2.0
        case .typing: return 5.0
        case .scrolling: return 15.0
        case .burst: return 30.0  // Temporary burst
        }
    }
}

// MARK: - CaptureEngine

@available(macOS 14.0, *)
class CaptureEngine: NSObject, SCContentSharingPickerObserver {

    static let shared = CaptureEngine()

    private var stream: SCStream?
    private var streamOutput: StreamOutput?
    private var contentFilter: SCContentFilter?
    private(set) var isCapturing = false

    // Adaptive FPS state
    private var adaptiveFPSEnabled = true
    private var currentActivityLevel: ActivityLevel = .reading
    private var lastActivityTime: Date = Date()
    private var activityCheckTimer: Timer?
    private var burstRemaining = 0

    // Event monitors for activity detection
    private var globalEventMonitor: Any?
    private var localEventMonitor: Any?
    private var workspaceObserver: NSObjectProtocol?

    // Stats
    private var statsFramesCaptured: UInt64 = 0
    private var statsFramesDropped: UInt64 = 0
    private var statsBurstTriggers: UInt64 = 0

    private static let ipcDirectory: String = {
        let path = NSString("~/.sinain/capture").expandingTildeInPath
        return path
    }()

    override init() {
        super.init()
        ensureIPCDirectory()
        setupEventMonitors()
    }

    deinit {
        removeEventMonitors()
    }

    private func ensureIPCDirectory() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: Self.ipcDirectory) {
            try? fm.createDirectory(atPath: Self.ipcDirectory, withIntermediateDirectories: true)
        }
    }

    // MARK: Event Monitors

    private func setupEventMonitors() {
        // Global mouse/keyboard event monitor for activity detection
        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.mouseMoved, .scrollWheel, .keyDown, .leftMouseDragged]
        ) { [weak self] event in
            self?.handleActivityEvent(event)
        }

        // Workspace notification for app switches
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleAppSwitch(notification)
        }

        // Activity decay timer
        activityCheckTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkActivityDecay()
        }
    }

    private func removeEventMonitors() {
        if let monitor = globalEventMonitor {
            NSEvent.removeMonitor(monitor)
            globalEventMonitor = nil
        }
        if let observer = workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            workspaceObserver = nil
        }
        activityCheckTimer?.invalidate()
        activityCheckTimer = nil
    }

    private func handleActivityEvent(_ event: NSEvent) {
        lastActivityTime = Date()

        // Classify activity type
        let newLevel: ActivityLevel
        switch event.type {
        case .scrollWheel:
            newLevel = .scrolling
        case .keyDown:
            newLevel = .typing
        case .mouseMoved, .leftMouseDragged:
            // Fast mouse movement suggests scrolling/navigation
            let velocity = sqrt(pow(event.deltaX, 2) + pow(event.deltaY, 2))
            newLevel = velocity > 10 ? .scrolling : .reading
        default:
            newLevel = .reading
        }

        // Only increase activity level, decay handles decrease
        if newLevel.rawValue > currentActivityLevel.rawValue && burstRemaining == 0 {
            updateActivityLevel(newLevel)
        }
    }

    private func handleAppSwitch(_ notification: Notification) {
        NSLog("[ScreenCapture] App switch detected, triggering burst")
        triggerBurst(count: 3)
    }

    private func checkActivityDecay() {
        let timeSinceActivity = Date().timeIntervalSince(lastActivityTime)

        // Decay activity level over time
        if burstRemaining > 0 {
            // Burst mode: capture quickly then return
            burstRemaining -= 1
            if burstRemaining == 0 {
                updateActivityLevel(currentActivityLevel)
            }
        } else if timeSinceActivity > 30 {
            updateActivityLevel(.idle)
        } else if timeSinceActivity > 10 {
            updateActivityLevel(.reading)
        } else if currentActivityLevel == .scrolling && timeSinceActivity > 2 {
            updateActivityLevel(.typing)
        }
    }

    private func updateActivityLevel(_ level: ActivityLevel) {
        guard adaptiveFPSEnabled, isCapturing else { return }
        guard level != currentActivityLevel || burstRemaining > 0 else { return }

        currentActivityLevel = level
        let targetFPS = burstRemaining > 0 ? ActivityLevel.burst.fps : level.fps

        // Update stream configuration
        if let stream = stream {
            let config = SCStreamConfiguration()
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(targetFPS))
            config.pixelFormat = kCVPixelFormatType_32BGRA

            // Keep current resolution
            if let filter = contentFilter {
                config.width = Int(filter.contentRect.width) / 2
                config.height = Int(filter.contentRect.height) / 2
            }
            config.queueDepth = 3

            stream.updateConfiguration(config) { error in
                if let error = error {
                    NSLog("[ScreenCapture] Failed to update FPS: \(error.localizedDescription)")
                } else {
                    NSLog("[ScreenCapture] FPS updated to \(targetFPS) (activity: \(level))")
                }
            }
        }
    }

    // MARK: Public API

    func setAdaptiveFPS(enabled: Bool) {
        adaptiveFPSEnabled = enabled
        NSLog("[ScreenCapture] Adaptive FPS: \(enabled ? "enabled" : "disabled")")
    }

    func setFPS(_ fps: Double) {
        guard isCapturing, let stream = stream else { return }

        adaptiveFPSEnabled = false  // Manual FPS disables adaptive

        let config = SCStreamConfiguration()
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA

        if let filter = contentFilter {
            config.width = Int(filter.contentRect.width) / 2
            config.height = Int(filter.contentRect.height) / 2
        }
        config.queueDepth = 3

        stream.updateConfiguration(config) { error in
            if let error = error {
                NSLog("[ScreenCapture] Failed to set FPS: \(error.localizedDescription)")
            } else {
                NSLog("[ScreenCapture] FPS set to \(fps)")
            }
        }
    }

    func triggerBurst(count: Int) {
        burstRemaining = count
        statsBurstTriggers += 1

        // Immediately switch to burst mode
        updateActivityLevel(.burst)

        NSLog("[ScreenCapture] Burst triggered: \(count) frames")
    }

    func getStats() -> [String: Any] {
        return [
            "isCapturing": isCapturing,
            "adaptiveFPS": adaptiveFPSEnabled,
            "currentFPS": currentActivityLevel.fps,
            "activityLevel": currentActivityLevel.rawValue,
            "framesCaptured": statsFramesCaptured,
            "framesDropped": statsFramesDropped,
            "burstTriggers": statsBurstTriggers,
        ]
    }

    // MARK: Picker

    func showPicker() {
        let picker = SCContentSharingPicker.shared
        picker.add(self)

        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleDisplay, .singleWindow, .singleApplication]
        picker.defaultConfiguration = config

        picker.isActive = true
        picker.present()
    }

    // MARK: SCContentSharingPickerObserver

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        self.contentFilter = filter
        NSLog("[ScreenCapture] Picker selection updated, auto-starting capture")
        startCapture(completion: nil)
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        NSLog("[ScreenCapture] Picker cancelled")
    }

    func contentSharingPickerDidCancel(_ picker: SCContentSharingPicker) {
        NSLog("[ScreenCapture] Picker dismissed")
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        NSLog("[ScreenCapture] Picker start failed: \(error.localizedDescription)")
    }

    // MARK: Capture

    func startCapture(completion: ((Error?) -> Void)?) {
        guard let filter = contentFilter else {
            let err = NSError(domain: "ScreenCapture", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "No content selected — use showPicker() first"])
            completion?(err)
            return
        }

        if isCapturing {
            stopCapture()
        }

        let config = SCStreamConfiguration()
        // Start with reading-level FPS
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(ActivityLevel.reading.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA

        // Half-resolution: query the filter's content rect for sizing
        config.width = Int(filter.contentRect.width) / 2
        config.height = Int(filter.contentRect.height) / 2

        // Discard frames when behind
        config.queueDepth = 3

        let output = StreamOutput(ipcDirectory: Self.ipcDirectory) { [weak self] captured, dropped in
            self?.statsFramesCaptured += captured
            self?.statsFramesDropped += dropped
        }
        self.streamOutput = output

        do {
            let newStream = SCStream(filter: filter, configuration: config, delegate: output)
            try newStream.addStreamOutput(output, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))
            self.stream = newStream

            newStream.startCapture { [weak self] error in
                if let error = error {
                    NSLog("[ScreenCapture] Failed to start: \(error.localizedDescription)")
                    completion?(error)
                } else {
                    self?.isCapturing = true
                    self?.currentActivityLevel = .reading
                    NSLog("[ScreenCapture] Capture started with adaptive FPS")
                    completion?(nil)
                }
            }
        } catch {
            NSLog("[ScreenCapture] Stream setup error: \(error.localizedDescription)")
            completion?(error)
        }
    }

    func stopCapture() {
        guard isCapturing, let stream = stream else { return }
        stream.stopCapture { [weak self] error in
            if let error = error {
                NSLog("[ScreenCapture] Stop error: \(error.localizedDescription)")
            }
            self?.isCapturing = false
            self?.stream = nil
            self?.streamOutput = nil
            NSLog("[ScreenCapture] Capture stopped")
        }
        cleanupIPCFiles()
    }

    private func cleanupIPCFiles() {
        let fm = FileManager.default
        let framePath = (Self.ipcDirectory as NSString).appendingPathComponent("frame.jpg")
        let metaPath = (Self.ipcDirectory as NSString).appendingPathComponent("meta.json")
        try? fm.removeItem(atPath: framePath)
        try? fm.removeItem(atPath: metaPath)
    }
}

// MARK: - StreamOutput

@available(macOS 14.0, *)
class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {

    private let ipcDirectory: String
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private var frameCount: UInt64 = 0
    private var droppedCount: UInt64 = 0
    private let statsCallback: (UInt64, UInt64) -> Void

    // Change detection for efficient IPC
    private var lastFrameHash: Int = 0

    init(ipcDirectory: String, statsCallback: @escaping (UInt64, UInt64) -> Void = { _, _ in }) {
        self.ipcDirectory = ipcDirectory
        self.statsCallback = statsCallback
        super.init()
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }

        // Check frame status — skip idle/blank frames
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw) else {
            return
        }

        if status == .idle || status == .blank {
            droppedCount += 1
            return
        }

        guard status == .complete else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }

        // Quick hash to detect duplicate frames
        let currentHash = computeQuickHash(cgImage)
        if currentHash == lastFrameHash {
            droppedCount += 1
            return  // Skip duplicate frames
        }
        lastFrameHash = currentHash

        // Encode as JPEG
        let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
        guard let jpegData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return }

        // Atomic write: .tmp → rename
        let framePath = (ipcDirectory as NSString).appendingPathComponent("frame.jpg")
        let tmpPath = (ipcDirectory as NSString).appendingPathComponent("frame.jpg.tmp")

        do {
            try jpegData.write(to: URL(fileURLWithPath: tmpPath), options: .atomic)
            let fm = FileManager.default
            // Remove destination if exists, then rename
            if fm.fileExists(atPath: framePath) {
                try fm.removeItem(atPath: framePath)
            }
            try fm.moveItem(atPath: tmpPath, toPath: framePath)
        } catch {
            NSLog("[ScreenCapture] Frame write error: \(error.localizedDescription)")
            return
        }

        // Write metadata with activity info
        frameCount += 1
        let meta: [String: Any] = [
            "timestamp": Date().timeIntervalSince1970,
            "width": cgImage.width,
            "height": cgImage.height,
            "frameCount": frameCount,
            "droppedCount": droppedCount,
        ]

        if let metaData = try? JSONSerialization.data(withJSONObject: meta) {
            let metaPath = (ipcDirectory as NSString).appendingPathComponent("meta.json")
            let metaTmpPath = (ipcDirectory as NSString).appendingPathComponent("meta.json.tmp")
            try? metaData.write(to: URL(fileURLWithPath: metaTmpPath), options: .atomic)
            let fm = FileManager.default
            try? fm.removeItem(atPath: metaPath)
            try? fm.moveItem(atPath: metaTmpPath, toPath: metaPath)
        }

        // Report stats
        statsCallback(1, 0)
    }

    /// Quick hash for duplicate detection (samples corner pixels)
    private func computeQuickHash(_ image: CGImage) -> Int {
        // Sample a few pixels for quick comparison
        guard let dataProvider = image.dataProvider,
              let data = dataProvider.data,
              let bytes = CFDataGetBytePtr(data) else {
            return 0
        }

        let bytesPerPixel = image.bitsPerPixel / 8
        let bytesPerRow = image.bytesPerRow
        let width = image.width
        let height = image.height

        // Sample 4 corners + center
        var hash = 0
        let samples = [
            (0, 0),
            (width - 1, 0),
            (0, height - 1),
            (width - 1, height - 1),
            (width / 2, height / 2),
        ]

        for (x, y) in samples {
            let offset = y * bytesPerRow + x * bytesPerPixel
            if offset + 2 < CFDataGetLength(data) {
                let r = Int(bytes[offset])
                let g = Int(bytes[offset + 1])
                let b = Int(bytes[offset + 2])
                hash = hash &* 31 &+ (r + g + b)
            }
        }

        return hash
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        NSLog("[ScreenCapture] Stream stopped with error: \(error.localizedDescription)")
        statsCallback(0, 1)
    }
}
