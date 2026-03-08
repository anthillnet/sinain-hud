import Foundation

/// Content-aware frame gating — classifies frames into scene/text/motion/ambient/drop.
///
/// Classification priority chain:
///   1. In-flight guard        -> DROP
///   2. blurScore < threshold  -> DROP "blurry"
///   3. brightness extreme     -> DROP "exposure"
///   4. First frame (no hash)  -> SCENE "first frame"
///   5. Hash hamming dist < 5  -> DROP "duplicate" (or AMBIENT heartbeat)
///   6. Hash hamming dist > 15 -> SCENE "major change"
///   7. textRegions >= 2       -> TEXT
///   8. |brightness delta| > 30-> MOTION
///   9. 30s since last ambient -> AMBIENT
///  10. Default                -> DROP
final class SceneGate: SceneGating {

    private let config: SceneGateConfig
    private let log = PipelineLogger(subsystem: "SceneGate")
    private var inFlight = false
    private var prevHash: String?
    private var prevBrightness: Double?
    private var lastSend: [FrameClass: Double] = [:]
    private var lastAmbientTime: Double = 0

    init(config: SceneGateConfig) {
        self.config = config
    }

    func classify(_ analysis: FrameAnalysis) -> GateResult {
        let now = Date().timeIntervalSince1970 * 1000

        // 1. In-flight guard
        if inFlight {
            return GateResult(classification: .drop, reason: "in-flight")
        }

        // 2. Blur rejection
        if config.blurThreshold > 0 && analysis.blurScore < config.blurThreshold {
            return GateResult(classification: .drop, reason: "blurry")
        }

        // 3. Exposure rejection
        if analysis.brightnessAvg < config.brightnessMin || analysis.brightnessAvg > config.brightnessMax {
            return GateResult(classification: .drop, reason: "exposure")
        }

        // 4. First frame — always send as SCENE
        guard let prevHash = prevHash else {
            accept(.scene, analysis: analysis, now: now)
            return GateResult(classification: .scene, reason: "first frame")
        }

        // 5-6. Perceptual hash comparison
        let dist = Self.hammingDistance(prevHash, analysis.perceptualHash)

        if dist < config.duplicateHashDist {
            if now - lastAmbientTime >= config.ambientIntervalMs {
                accept(.ambient, analysis: analysis, now: now)
                return GateResult(classification: .ambient, reason: "heartbeat")
            }
            return GateResult(classification: .drop, reason: "duplicate")
        }

        if dist > config.sceneHashDist {
            if !inCooldown(.scene, now: now) {
                accept(.scene, analysis: analysis, now: now)
                return GateResult(classification: .scene, reason: "major change")
            }
        }

        // 7. Text regions
        let confidentCount = analysis.textRegionConfidences.filter { $0 > config.textMinConfidence }.count
        if confidentCount >= config.textMinRegions {
            if !inCooldown(.text, now: now) {
                accept(.text, analysis: analysis, now: now)
                return GateResult(classification: .text, reason: "\(confidentCount) text regions")
            }
        }

        // 8. Motion proxy (brightness delta)
        if let prev = prevBrightness {
            let delta = abs(analysis.brightnessAvg - prev)
            if delta > config.brightnessDelta {
                if !inCooldown(.motion, now: now) {
                    accept(.motion, analysis: analysis, now: now)
                    return GateResult(classification: .motion, reason: "brightness delta \(Int(delta))")
                }
            }
        }

        // 9. Ambient heartbeat
        if now - lastAmbientTime >= config.ambientIntervalMs {
            accept(.ambient, analysis: analysis, now: now)
            return GateResult(classification: .ambient, reason: "heartbeat")
        }

        // 10. Default
        return GateResult(classification: .drop, reason: "no trigger")
    }

    func markProcessing() { inFlight = true }
    func markDone() { inFlight = false }

    // MARK: - Private

    private func accept(_ cls: FrameClass, analysis: FrameAnalysis, now: Double) {
        prevHash = analysis.perceptualHash
        prevBrightness = analysis.brightnessAvg
        lastSend[cls] = now
        if cls == .ambient {
            lastAmbientTime = now
        }
    }

    private func inCooldown(_ cls: FrameClass, now: Double) -> Bool {
        let last = lastSend[cls] ?? 0
        let cooldown = getCooldown(cls)
        return (now - last) < cooldown
    }

    private func getCooldown(_ cls: FrameClass) -> Double {
        switch cls {
        case .scene: return config.sceneCooldownMs
        case .text: return config.textCooldownMs
        case .motion: return config.motionCooldownMs
        default: return 0
        }
    }

    /// Hamming distance between two hex-encoded 64-bit hashes.
    static func hammingDistance(_ a: String, _ b: String) -> Int {
        let ai = UInt64(a, radix: 16) ?? 0
        let bi = UInt64(b, radix: 16) ?? 0
        return (ai ^ bi).nonzeroBitCount
    }
}
