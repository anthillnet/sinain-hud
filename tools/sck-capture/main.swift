import AVFoundation
import CoreAudio
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
// Pin capture to the main display and never follow the active one. Multi-display
// follow is the source of wrong-display ROI placement; pinning keeps every frame
// (and every eye) on one known screen until that's solid.
var pinDisplay: Bool = false
// Permission probes for the first-run wizard. The grant that matters belongs to
// THIS binary (the actual capturer), not the overlay app, so the wizard runs us
// to trigger / poll it — and the macOS prompt names sck-capture, as the wizard
// copy promises.
var requestPermission: Bool = false   // exercise the real capture path → prompt
var checkPermission: Bool = false     // non-prompting status poll
// Mic mode: AVAudioEngine input tap → s16le PCM to stdout. Audio only — no
// screen, no ScreenCaptureKit, no Screen Recording permission; it needs the
// Microphone permission instead (prompted on first run).
var micMode: Bool = false
var micDevice: String? = nil          // input device by name; nil = default

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
    case "--mic":
        micMode = true
    case "--mic-device":
        if let next = args.first { micDevice = next; args = args.dropFirst() }
    case "--pin-display":
        pinDisplay = true
    case "--request-permission":
        requestPermission = true
    case "--check-permission":
        checkPermission = true
    case "--help", "-h":
        fputs("Usage: sck-capture [--sample-rate 16000] [--channels 1]\n", stderr)
        fputs("                 [--screen-dir ~/.sinain/capture] [--fps 1] [--scale 0.5]\n", stderr)
        fputs("                 [--no-audio] [--pin-display]\n", stderr)
        fputs("                 [--mic] [--mic-device <name>]\n", stderr)
        fputs("                 [--request-permission] [--check-permission]\n", stderr)
        fputs("Captures system audio + screen via ScreenCaptureKit.\n", stderr)
        fputs("Audio: raw s16le PCM to stdout.\n", stderr)
        fputs("Screen: JPEG frames to --screen-dir (atomic write).\n", stderr)
        fputs("--mic: microphone only via AVAudioEngine (PCM to stdout, no screen).\n", stderr)
        fputs("Requires macOS 13+. Grant Screen Recording permission on first run\n", stderr)
        fputs("(Microphone permission for --mic).\n", stderr)
        exit(0)
    default:
        fputs("Unknown arg: \(arg)\n", stderr)
        exit(1)
    }
}

// ── Permission probes (first-run wizard) ──
// Exit before any capture setup. --check-permission is a non-prompting status
// read (CGPreflight); --request-permission exercises the real capture entry
// point (SCShareableContent), which triggers the macOS Screen Recording prompt
// on first run. Both report via exit code: 0 = granted, 1 = not granted.
if checkPermission {
    exit(CGPreflightScreenCaptureAccess() ? 0 : 1)
}
if requestPermission {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            granted = !content.displays.isEmpty
        } catch {
            granted = false   // permission missing — the prompt has been shown
        }
        sem.signal()
    }
    sem.wait()
    exit(granted ? 0 : 1)
}

fputs("[sck-capture] sample_rate=\(sampleRate) channels=\(channels) fps=\(fps) scale=\(scale) audio=\(audioEnabled) mic=\(micMode)\n", stderr)

// Disable stdout buffering for real-time piping
setbuf(stdout, nil)

// ── Mic mode: AVAudioEngine input tap → s16le PCM on stdout ─────────────────
// Audio only: no SCStream, no screen files, no Screen Recording permission.
// The consumer (sinain-core AudioPipeline) reads the same raw stream the
// system-audio path produces, so VAD/transcription downstream are identical.

/// CoreAudio lookup: input AudioDeviceID by (case-insensitive) device name.
func inputDeviceID(named wanted: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devices) == noErr else { return nil }
    for dev in devices {
        // Input-capable? (has input stream configuration)
        var inAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var cfgSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(dev, &inAddr, 0, nil, &cfgSize) == noErr, cfgSize > 0 else { continue }
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var nameRef: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(dev, &nameAddr, 0, nil, &nameSize, &nameRef) == noErr,
              let name = nameRef?.takeRetainedValue() as String? else { continue }
        if name.lowercased() == wanted.lowercased() { return dev }
    }
    return nil
}

func runMic() -> Never {
    // Microphone permission first — a denied engine yields silent zeros, which
    // downstream reads as "capturing but idle" forever. Fail loud instead.
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; sem.signal() }
    sem.wait()
    guard granted else {
        fputs("[sck-capture] error: Microphone permission not granted\n", stderr)
        exit(1)
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode

    // Optional device selection (System Settings default otherwise).
    if let wanted = micDevice {
        if var dev = inputDeviceID(named: wanted) {
            var status = noErr
            if let unit = input.audioUnit {
                status = AudioUnitSetProperty(
                    unit, kAudioOutputUnitProperty_CurrentDevice,
                    kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
            }
            fputs("[sck-capture] mic device \"\(wanted)\" → id \(dev) (set: \(status == noErr))\n", stderr)
        } else {
            fputs("[sck-capture] mic device \"\(wanted)\" not found — using default input\n", stderr)
        }
    }

    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0 else {
        fputs("[sck-capture] error: no usable input device\n", stderr)
        exit(1)
    }
    guard let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate),
        channels: AVAudioChannelCount(channels), interleaved: true),
          let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
        fputs("[sck-capture] error: cannot build \(sampleRate)Hz/\(channels)ch converter\n", stderr)
        exit(1)
    }

    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
        let ratio = outFormat.sampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var convErr: NSError?
        converter.convert(to: out, error: &convErr) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard convErr == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let bytes = Int(out.frameLength) * Int(outFormat.streamDescription.pointee.mBytesPerFrame)
        fwrite(ch[0], 1, bytes, stdout)
    }

    do {
        try engine.start()
    } catch {
        fputs("[sck-capture] error: mic engine start failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    fputs("[sck-capture] mic capturing (\(inFormat.sampleRate)Hz in → \(sampleRate)Hz s16le out)\n", stderr)

    // Clean shutdown + orphan watchdog (mirror the SCK path).
    let sigSources = [
        DispatchSource.makeSignalSource(signal: SIGINT, queue: .main),
        DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main),
    ]
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for src in sigSources {
        src.setEventHandler {
            fputs("\n[sck-capture] stopping mic...\n", stderr)
            engine.stop()
            exit(0)
        }
        src.resume()
    }
    let parentPid = getppid()
    let watchdog = DispatchSource.makeTimerSource(queue: .main)
    watchdog.schedule(deadline: .now() + 1, repeating: 1)
    watchdog.setEventHandler {
        if getppid() != parentPid {
            fputs("[sck-capture] parent process died — exiting\n", stderr)
            engine.stop()
            exit(0)
        }
    }
    watchdog.resume()
    // Keep sigSources/watchdog alive for the process lifetime.
    withExtendedLifetime((sigSources, watchdog)) { dispatchMain() }
}

if micMode {
    runMic()
}

// SECURITY: the captured frame is a live screenshot — never world/group
// readable. Make every file we create owner-only (frame.jpg, meta.json, tmp).
umask(0o077)

// ── Ensure screen output directory exists (owner-only) ──
do {
    let fm = FileManager.default
    if !fm.fileExists(atPath: screenDir) {
        try? fm.createDirectory(atPath: screenDir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
    } else {
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: screenDir)
    }
}

// ── Stream output delegate ──
class CaptureOutputHandler: NSObject, SCStreamOutput {
    let screenDir: String
    let audioEnabled: Bool
    let fps: Double
    private var lastFrameTime: Double = 0
    private var audioFormatLogged = false
    // Active-display state (multi-display prototype): which display we're
    // currently capturing + its capture pixel dims, written into meta.json so
    // sense/core/overlay can place ROIs on the right display.
    var displayID: UInt32 = 0
    var captureW: Int = 0
    var captureH: Int = 0

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
        // One-time log of actual audio format from ScreenCaptureKit
        if !audioFormatLogged {
            if let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) {
                let fmt = asbd.pointee
                fputs("[sck-capture] audio format: \(fmt.mSampleRate)Hz, \(fmt.mChannelsPerFrame)ch, \(fmt.mBitsPerChannel)bit, flags=0x\(String(fmt.mFormatFlags, radix: 16))\n", stderr)
            }
            audioFormatLogged = true
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let length = CMBlockBufferGetDataLength(blockBuffer)
        guard length > 0 else { return }

        // Read raw Float32 samples from ScreenCaptureKit
        var floatData = Data(count: length)
        floatData.withUnsafeMutableBytes { rawPtr in
            guard let baseAddress = rawPtr.baseAddress else { return }
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
        }

        // Convert Float32 (-1.0..1.0) → Int16 (-32768..32767)
        let sampleCount = length / 4  // Float32 = 4 bytes
        var int16Data = Data(count: sampleCount * 2)  // Int16 = 2 bytes
        floatData.withUnsafeBytes { srcPtr in
            int16Data.withUnsafeMutableBytes { dstPtr in
                guard let src = srcPtr.baseAddress?.assumingMemoryBound(to: Float32.self),
                      let dst = dstPtr.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                for i in 0..<sampleCount {
                    let clamped = min(max(src[i], -1.0), 1.0)
                    dst[i] = Int16(clamped * 32767.0)
                }
            }
        }

        // Write Int16 PCM to stdout
        int16Data.withUnsafeBytes { rawPtr in
            guard let base = rawPtr.baseAddress else { return }
            fwrite(base, 1, int16Data.count, stdout)
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

        // Write metadata — `display` lets the pipeline place ROIs on the
        // active display; width/height are the capture-frame pixel dims.
        let timestamp = Date().timeIntervalSince1970
        let metaJson = "{\"timestamp\": \(timestamp), \"display\": \(displayID), \"width\": \(captureW), \"height\": \(captureH)}"
        do {
            try metaJson.write(toFile: metaTmpPath, atomically: false, encoding: .utf8)
            try FileManager.default.moveItem(atPath: metaTmpPath, toPath: metaPath)
        } catch {
            try? FileManager.default.removeItem(atPath: metaPath)
            try? FileManager.default.moveItem(atPath: metaTmpPath, toPath: metaPath)
        }
    }
}

// ── Active-display detection (multi-display prototype) ──
// The "active display" is the one under the mouse cursor. Simple, robust
// heuristic for the prototype; can later be upgraded to the display holding
// the frontmost window. CGEvent location is in global top-left-origin coords;
// CGGetDisplaysWithPoint maps it to a CGDirectDisplayID.
func activeDisplayID() -> CGDirectDisplayID {
    let loc = CGEvent(source: nil)?.location ?? .zero
    var ids = [CGDirectDisplayID](repeating: 0, count: 8)
    var count: UInt32 = 0
    CGGetDisplaysWithPoint(loc, 8, &ids, &count)
    return count > 0 ? ids[0] : CGMainDisplayID()
}

// ── Main async entry ──
func run() async throws {
    // Get shareable content (triggers permission dialog on first run)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

    guard !content.displays.isEmpty else {
        fputs("[sck-capture] error: no displays found\n", stderr)
        exit(1)
    }
    func scDisplay(for id: CGDirectDisplayID) -> SCDisplay {
        content.displays.first { $0.displayID == id } ?? content.displays.first!
    }

    // Pinned: lock to the main (primary) display. Otherwise follow the display
    // under the cursor.
    var activeID = pinDisplay ? CGMainDisplayID() : activeDisplayID()
    var display = scDisplay(for: activeID)

    let config = SCStreamConfiguration()
    // Audio configuration
    config.capturesAudio = audioEnabled
    config.excludesCurrentProcessAudio = false
    if audioEnabled {
        config.sampleRate = sampleRate
        config.channelCount = channels
    }
    config.showsCursor = false
    config.minimumFrameInterval = CMTime(value: Int64(1000.0 / fps), timescale: 1000)

    let handler = CaptureOutputHandler(
        screenDir: screenDir,
        audioEnabled: audioEnabled,
        fps: fps
    )

    // Configure the stream for a given display (dims scale to its resolution).
    func applyDisplay(_ d: SCDisplay) {
        let w = Int(Double(d.width) * scale)
        let h = Int(Double(d.height) * scale)
        config.width = w
        config.height = h
        handler.displayID = d.displayID
        handler.captureW = w
        handler.captureH = h
        fputs("[sck-capture] active display \(d.displayID): \(w)x\(h) @ \(fps) fps → \(screenDir)\n", stderr)
    }
    applyDisplay(display)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
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

    // Poll loop: follow the active display + exit if orphaned (parent died).
    let parentPid = getppid()
    while true {
        try await Task.sleep(for: .seconds(1))
        if getppid() != parentPid {
            fputs("[sck-capture] parent process died — exiting\n", stderr)
            try? await stream.stopCapture()
            exit(0)
        }
        // Pinned to the main display — never switch.
        if pinDisplay { continue }
        // Follow the active display. updateContentFilter/Configuration (macOS
        // 14+) switch the captured display WITHOUT restarting the stream, so
        // audio keeps flowing. On older systems we stay on the initial display.
        let newID = activeDisplayID()
        if newID != activeID, content.displays.contains(where: { $0.displayID == newID }) {
            let newDisplay = scDisplay(for: newID)
            if #available(macOS 14.0, *) {
                applyDisplay(newDisplay)
                let newFilter = SCContentFilter(display: newDisplay, excludingWindows: [])
                do {
                    try await stream.updateConfiguration(config)
                    try await stream.updateContentFilter(newFilter)
                    activeID = newID
                    display = newDisplay
                } catch {
                    fputs("[sck-capture] display switch failed: \(error.localizedDescription)\n", stderr)
                }
            }
        }
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
