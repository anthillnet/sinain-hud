import Foundation

// MARK: - Data Types

/// Result of native frame analysis (blur, brightness, hash, OCR).
struct FrameAnalysis {
    let blurScore: Double
    let brightnessAvg: Double
    let perceptualHash: String
    let textRegionCount: Int
    let textRegionConfidences: [Double]
    let nativeOcrText: String
    let analysisMs: Double
}

/// Frame classification types.
enum FrameClass: String {
    case scene, text, motion, ambient, drop
}

/// Result from scene gate classification.
struct GateResult {
    let classification: FrameClass
    let reason: String
}

/// Vision API result.
struct VisionResult {
    let description: String
    let ocrText: String
    let latencyMs: Int
}

// MARK: - Pipeline Protocols

/// Provides raw frame data from the camera SDK.
protocol FrameProviding: AnyObject {
    func getLastFrameData() -> Data?
    func getFrameBase64() -> String?
    func frameStaleness() -> TimeInterval
    var isStreamActive: Bool { get }
    func requestStreamRestart()
}

/// Analyzes a JPEG frame for blur, brightness, hash, and text regions.
protocol FrameAnalyzing {
    func analyze(_ jpegData: Data) async -> FrameAnalysis?
}

/// Classifies frames into scene/text/motion/ambient/drop.
protocol SceneGating {
    func classify(_ analysis: FrameAnalysis) -> GateResult
    func markProcessing()
    func markDone()
}

/// Sends frames to vision API for description + OCR.
protocol VisionAnalyzing {
    func analyzeFrame(
        base64Jpeg: String,
        apiKey: String,
        model: String,
        timeoutMs: Int,
        classification: FrameClass
    ) async -> VisionResult
}

/// Manages observation history and builds markdown messages.
protocol ObservationBuilding {
    var tick: Int { get }
    func add(description: String, ocrText: String, classification: FrameClass?)
    func buildMessage(description: String, ocrText: String, classification: FrameClass) -> String
}

/// WebSocket gateway for agent RPC.
protocol GatewayConnecting: AnyObject {
    var isConnected: Bool { get }
    var isCircuitOpen: Bool { get }
    func start()
    func close()
    func sendAgentRpc(message: String, idempotencyKey: String) async -> String?
}

/// Emits pipeline events to the React Native bridge.
protocol EventEmitting: AnyObject {
    func emitPipelineResponse(text: String, tick: Int, isStreaming: Bool)
    func emitPipelineStatus(gatewayStatus: String, rpcStatus: String, tick: Int)
}

/// Sends data to the Apple Watch.
protocol WatchSyncing {
    func sendToWatch(text: String, tick: Int, isStreaming: Bool, gatewayConnected: Bool)
}
