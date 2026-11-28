package com.isinain.pipeline

/**
 * All pipeline data types and protocol interfaces.
 * Mirrors iOS Protocols.swift — defines the contract layer for every pipeline component.
 */

// ── Data Classes ──────────────────────────────────────────────

data class FrameAnalysis(
    val blurScore: Double,
    val brightnessAvg: Double,
    val perceptualHash: String,
    val textRegionCount: Int,
    val textRegionConfidences: List<Double>,
    val nativeOcrText: String,
    val analysisMs: Double
)

enum class FrameClass(val value: String) {
    SCENE("scene"),
    TEXT("text"),
    MOTION("motion"),
    AMBIENT("ambient"),
    DROP("drop");

    companion object {
        fun from(raw: String): FrameClass =
            entries.firstOrNull { it.value == raw } ?: DROP
    }
}

data class GateResult(
    val classification: FrameClass,
    val reason: String
)

data class VisionResult(
    val description: String,
    val ocrText: String,
    val latencyMs: Int
)

// ── Interfaces (Protocol equivalents) ─────────────────────────

interface FrameProviding {
    fun getLastFrameData(): ByteArray?
    fun getFrameBase64(): String?
    fun frameStaleness(): Double
    val isStreamActive: Boolean
    fun requestStreamRestart()
}

interface FrameAnalyzing {
    suspend fun analyze(jpegData: ByteArray): FrameAnalysis?
}

interface SceneGating {
    fun classify(analysis: FrameAnalysis): GateResult
    fun markProcessing()
    fun markDone()
}

interface VisionAnalyzing {
    suspend fun analyzeFrame(
        base64Jpeg: String,
        apiKey: String,
        model: String,
        timeoutMs: Int = 15_000,
        classification: FrameClass = FrameClass.SCENE
    ): VisionResult
}

interface ObservationBuilding {
    val tick: Int
    fun add(description: String, ocrText: String, classification: FrameClass? = null)
    fun buildMessage(description: String, ocrText: String, classification: FrameClass = FrameClass.SCENE): String
}

interface GatewayConnecting {
    val isConnected: Boolean
    val isCircuitOpen: Boolean
    fun start()
    fun close()
    suspend fun sendAgentRpc(message: String, idempotencyKey: String): String?
}

interface EventEmitting {
    fun emitPipelineResponse(text: String, tick: Int, isStreaming: Boolean)
    fun emitPipelineStatus(gatewayStatus: String, rpcStatus: String, tick: Int)
}

interface WatchSyncing {
    fun sendToWatch(text: String, tick: Int, isStreaming: Boolean, gatewayConnected: Boolean)
}
