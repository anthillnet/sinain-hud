import Foundation

/// All pipeline configuration in one place.
/// Replaces the original `BackgroundConfig` (6 fields) with ~20 named fields.
struct PipelineConfig {

    // MARK: - Gateway

    var gatewayWsUrl: String = "wss://localhost:18789"
    var gatewayToken: String = ""
    var sessionKey: String = "agent:main:sinain"

    // MARK: - Vision

    var openRouterApiKey: String = ""
    var visionModel: String = "google/gemini-2.5-flash"
    var visionTimeoutMs: Int = 15_000

    // MARK: - Pipeline

    var tickIntervalS: TimeInterval = 4.0
    var maxStalenessMultiplier: Double = 3.0
    var maxStaleRestarts: Int = 2
    var staleRestartCooldownS: TimeInterval = 30

    // MARK: - Observation

    var observationMaxEntries: Int = 20
    var observationMaxAgeS: TimeInterval = 300

    // MARK: - Scene Gate

    var sceneGate: SceneGateConfig = SceneGateConfig()

    // MARK: - Factory

    /// Create config from NSDictionary passed over the React Native bridge.
    init(from dict: NSDictionary) {
        if let key = dict["openRouterApiKey"] as? String { openRouterApiKey = key }
        if let model = dict["visionModel"] as? String { visionModel = model }
        if let url = dict["gatewayWsUrl"] as? String { gatewayWsUrl = url }
        if let token = dict["gatewayToken"] as? String { gatewayToken = token }
        if let sk = dict["sessionKey"] as? String { sessionKey = sk }
    }

    /// Default config — sensible defaults for all fields.
    init() {}

    /// Max staleness before triggering a stream restart.
    var maxStalenessS: TimeInterval {
        tickIntervalS * maxStalenessMultiplier
    }
}

/// Scene gate thresholds — all in one place.
struct SceneGateConfig {
    var blurThreshold: Double = 50
    var brightnessMin: Double = 20
    var brightnessMax: Double = 240
    var duplicateHashDist: Int = 5
    var sceneHashDist: Int = 15
    var textMinRegions: Int = 2
    var textMinConfidence: Double = 0.3
    var brightnessDelta: Double = 30
    var sceneCooldownMs: Double = 2_000
    var textCooldownMs: Double = 5_000
    var motionCooldownMs: Double = 3_000
    var ambientIntervalMs: Double = 30_000
}
