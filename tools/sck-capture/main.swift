import AVFoundation
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

// ── CLI args ──
var sampleRate: Int = 16000
var channels: Int = 1
var screenDir: String = NSString("~/.sinain/capture").expandingTildeInPath
var fps: Double = 1.0
var scale: Double = 0.5
var audioEnabled: Bool = true

var args = CommandLine.arguments.dropFirst()
while let arg = args.first {
    args = args.dropFirst()
    switch arg {
    case "--sample-rate":
        if let next = args.first { sampleRate = Int(next) ?? 16000; args = args.dropFirst() }
    case "--channels":
        if let next = args.first { channels = Int(next) ?? 1; args = args.dropFirst() }
    case "--screen-dir":
        if let next = args.first { screenDir = NSString(string: next).expandingTildeInPath; args = args.dropFirst() }
    case "--fps":
        if let next = args.first { fps = Double(next) ?? 1.0; args = args.dropFirst() }
    case "--scale":
        if let next = args.first { scale = Double(next) ?? 0.5; args = args.dropFirst() }
    case "--no-audio":
        audioEnabled = false
    case "--help", "-h":
        fputs("Usage: sck-capture [--sample-rate 16000] [--channels 1]\n", stderr)
        fputs("                 [--screen-dir ~/.sinain/capture] [--fps 1] [--scale 0.5]\n", stderr)
        fputs("                 [--no-audio]\n", stderr)
        fputs("Captures system audio + screen via ScreenCaptureKit.\n", stderr)
        fputs("Audio: raw s16le PCM to stdout.\n", stderr)
        fputs("Screen: JPEG frames to --screen-dir (atomic write).\n", stderr)
        fputs("Requires macOS 13+. Grant Screen Recording permission on first run.\n", stderr)
        exit(0)
    default:
        fputs("Unknown arg: \(arg)\n", stderr)
        exit(1)
    }
}

fputs("[sck-capture] sample_rate=\(sampleRate) channels=\(channels) fps=\(fps) scale=\(scale) audio=\(audioEnabled)\n", stderr)

// Disable stdout buffering for real-time piping
setbuf(stdout, nil)

// ── Ensure screen output directory exists ──
do {
    let fm = FileManager.default
    if !fm.fileExists(atPath: screenDir) {
        try? fm.createDirectory(atPath: screenDir, withIntermediateDirectories: true)
    }
}

// ── Stream output delegate ──
class CaptureOutputHandler: NSObject, SCStreamOutput {
    let screenDir: String
    let audioEnabled: Bool
    let fps: Double
    private var lastFrameTime: Double = 0

    init(screenDir: String, audioEnabled: Bool, fps: Double) {
        self.screenDir = screenDir
        self.audioEnabled = audioEnabled
        self.fps = fps
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .audio:
            guard audioEnabled else { return }
            handleAudio(sampleBuffer)
        case .screen:
            handleScreen(sampleBuffer)
        case .microphone:
            break
        @unknown default:
            break
        }
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let length = CMBlockBufferGetDataLength(blockBuffer)
        guard length > 0 else { return }

        var data = Data(count: length)
        data.withUnsafeMutableBytes { rawPtr in
            guard let baseAddress = rawPtr.baseAddress else { return }
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
        }

        // Write raw PCM to stdout
        data.withUnsafeBytes { rawPtr in
            guard let base = rawPtr.baseAddress else { return }
            fwrite(base, 1, data.count, stdout)
        }
    }

    private func handleScreen(_ sampleBuffer: CMSampleBuffer) {
        // Rate limiting
        let now = CACurrentMediaTime()
        guard now - lastFrameTime >= (1.0 / fps) else { return }
        lastFrameTime = now

        // CMSampleBuffer → CVPixelBuffer → CGImage → JPEG data
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }

        // Create JPEG data using CGImage destination
        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(mutableData as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cgImage, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return }

        let jpegData = mutableData as Data

        // Atomic write: tmp file → rename
        let framePath = (screenDir as NSString).appendingPathComponent("frame.jpg")
        let tmpPath = framePath + ".tmp"
        let metaPath = (screenDir as NSString).appendingPathComponent("meta.json")
        let metaTmpPath = metaPath + ".tmp"

        do {
            try jpegData.write(to: URL(fileURLWithPath: tmpPath))
            try FileManager.default.moveItem(atPath: tmpPath, toPath: framePath)
        } catch {
            // Overwrite if target exists (rename fails if file exists)
            try? FileManager.default.removeItem(atPath: framePath)
            try? FileManager.default.moveItem(atPath: tmpPath, toPath: framePath)
        }

        // Write metadata
        let timestamp = Date().timeIntervalSince1970
        let metaJson = "{\"timestamp\": \(timestamp)}"
        do {
            try metaJson.write(toFile: metaTmpPath, atomically: false, encoding: .utf8)
            try FileManager.default.moveItem(atPath: metaTmpPath, toPath: metaPath)
        } catch {
            try? FileManager.default.removeItem(atPath: metaPath)
            try? FileManager.default.moveItem(atPath: metaTmpPath, toPath: metaPath)
        }
    }
}

// ── Main async entry ──
func run() async throws {
    // Get shareable content (triggers permission dialog on first run)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

    guard let display = content.displays.first else {
        fputs("[sck-capture] error: no displays found\n", stderr)
        exit(1)
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()

    // Audio configuration
    config.capturesAudio = audioEnabled
    config.excludesCurrentProcessAudio = false
    if audioEnabled {
        config.sampleRate = sampleRate
        config.channelCount = channels
    }

    // Screen configuration
    let screenWidth = Int(Double(display.width) * scale)
    let screenHeight = Int(Double(display.height) * scale)
    config.width = screenWidth
    config.height = screenHeight
    config.showsCursor = false
    config.minimumFrameInterval = CMTime(value: Int64(1000.0 / fps), timescale: 1000)
    fputs("[sck-capture] screen: \(screenWidth)x\(screenHeight) @ \(fps) fps → \(screenDir)\n", stderr)

    let stream = SCStream(filter: filter, configuration: config, delegate: nil)

    let handler = CaptureOutputHandler(
        screenDir: screenDir,
        audioEnabled: audioEnabled,
        fps: fps
    )

    try stream.addStreamOutput(handler, type: .screen, sampleHandlerQueue: .global(qos: .utility))
    try stream.addStreamOutput(handler, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))

    fputs("[sck-capture] starting capture...\n", stderr)
    try await stream.startCapture()
    fputs("[sck-capture] capturing (Ctrl+C to stop)\n", stderr)

    // Handle SIGINT/SIGTERM for clean shutdown
    let sigSources = [
        DispatchSource.makeSignalSource(signal: SIGINT, queue: .main),
        DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main),
    ]
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    for src in sigSources {
        src.setEventHandler {
            fputs("\n[sck-capture] stopping...\n", stderr)
            Task {
                try? await stream.stopCapture()
                exit(0)
            }
        }
        src.resume()
    }

    // Keep alive
    while true {
        try await Task.sleep(for: .seconds(3600))
    }
}

if #available(macOS 13.0, *) {
    Task {
        do {
            try await run()
        } catch {
            fputs("[sck-capture] error: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
    dispatchMain()
} else {
    fputs("[sck-capture] error: requires macOS 13+\n", stderr)
    exit(1)
}
