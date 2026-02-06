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
        default:
            result(FlutterMethodNotImplemented)
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

    private static let ipcDirectory: String = {
        let path = NSString("~/.sinain/capture").expandingTildeInPath
        return path
    }()

    override init() {
        super.init()
        ensureIPCDirectory()
    }

    private func ensureIPCDirectory() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: Self.ipcDirectory) {
            try? fm.createDirectory(atPath: Self.ipcDirectory, withIntermediateDirectories: true)
        }
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
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10) // 10 fps
        config.pixelFormat = kCVPixelFormatType_32BGRA

        // Half-resolution: query the filter's content rect for sizing
        config.width = Int(filter.contentRect.width) / 2
        config.height = Int(filter.contentRect.height) / 2

        // Discard frames when behind
        config.queueDepth = 3

        let output = StreamOutput(ipcDirectory: Self.ipcDirectory)
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
                    NSLog("[ScreenCapture] Capture started")
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

    init(ipcDirectory: String) {
        self.ipcDirectory = ipcDirectory
        super.init()
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }

        // Check frame status — skip idle/blank frames
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw),
              status == .complete else {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }

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

        // Write metadata
        frameCount += 1
        let meta: [String: Any] = [
            "timestamp": Date().timeIntervalSince1970,
            "width": cgImage.width,
            "height": cgImage.height,
            "frameCount": frameCount,
        ]

        if let metaData = try? JSONSerialization.data(withJSONObject: meta) {
            let metaPath = (ipcDirectory as NSString).appendingPathComponent("meta.json")
            let metaTmpPath = (ipcDirectory as NSString).appendingPathComponent("meta.json.tmp")
            try? metaData.write(to: URL(fileURLWithPath: metaTmpPath), options: .atomic)
            let fm = FileManager.default
            try? fm.removeItem(atPath: metaPath)
            try? fm.moveItem(atPath: metaTmpPath, toPath: metaPath)
        }
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        NSLog("[ScreenCapture] Stream stopped with error: \(error.localizedDescription)")
    }
}
