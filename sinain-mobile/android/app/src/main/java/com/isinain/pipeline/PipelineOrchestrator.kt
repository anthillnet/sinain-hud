package com.isinain.pipeline

import kotlinx.coroutines.*

/**
 * Pipeline orchestrator — runs the frame → analysis → gate → vision → gateway loop.
 * Port of iOS PipelineOrchestrator.swift using Kotlin coroutines.
 *
 * All dependencies injected via interfaces. Runs on Dispatchers.Default
 * using a coroutine-based ticker — never touches the main thread.
 *
 * Tick flow:
 *   1. Guard running + not processing
 *   2. Get frame from FrameProviding
 *   3. Check staleness → request stream restart if stale
 *   4. analyze(frameData) → FrameAnalysis
 *   5. gate.classify(analysis) → GateResult
 *   6. If DROP → return
 *   7. gate.markProcessing(); set processing flag
 *   8. vision.analyzeFrame(...) → VisionResult
 *   9. observation.add(...) + buildMessage(...) → markdown
 *  10. gateway.sendAgentRpc(message, key) → response
 *  11. Emit response via EventEmitting
 *  12. Send to watch via WatchSyncing
 *  13. Clear processing flag; gate.markDone()
 */
class PipelineOrchestrator(
    private val frameProvider: FrameProviding,
    private val analyzer: FrameAnalyzing,
    private val gate: SceneGating,
    private val vision: VisionAnalyzing,
    private val observation: ObservationBuilding,
    private val gateway: GatewayConnecting,
    private val eventEmitter: EventEmitting,
    private val watchSync: WatchSyncing?,
    private val config: PipelineConfig
) {
    var isRunning = false
        private set

    private val log = PipelineLogger("Pipeline")
    private var scope: CoroutineScope? = null
    private var tickJob: Job? = null
    private var processing = false
    private var startTime = 0L

    // Staleness restart tracking
    private var staleRestartCount = 0
    private var lastStaleRestart = 0L

    // ── Lifecycle ─────────────────────────────────────────────

    fun start() {
        if (isRunning) return
        isRunning = true
        processing = false
        startTime = System.currentTimeMillis()
        staleRestartCount = 0
        lastStaleRestart = 0

        scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        tickJob = scope?.launch {
            log.info("started (interval=${config.tickIntervalS}s)")

            // Notify watch that pipeline is active
            watchSync?.sendToWatch(
                text = "Pipeline active — processing every ${config.tickIntervalS.toInt()}s",
                tick = 0,
                isStreaming = false,
                gatewayConnected = gateway.isConnected
            )

            while (isActive) {
                tick()
                delay((config.tickIntervalS * 1000).toLong())
            }
        }
    }

    fun stop() {
        if (!isRunning) {
            log.debug("stop called but not running")
            return
        }

        val finalTick = observation.tick
        log.info("stopping (finalTick=$finalTick)")

        isRunning = false
        tickJob?.cancel()
        tickJob = null
        scope?.cancel()
        scope = null
        processing = false
        staleRestartCount = 0
        lastStaleRestart = 0

        log.info("stopped")
    }

    // ── Tick ──────────────────────────────────────────────────

    private suspend fun tick() {
        if (!isRunning || processing) {
            if (processing) {
                log.debug("tick skipped: still processing previous")
            }
            return
        }

        val currentTick = observation.tick
        val maxStaleS = config.maxStalenessS

        // Warm-up: pipeline just started, no frames expected yet
        val sinceStart = (System.currentTimeMillis() - startTime) / 1000.0
        if (sinceStart < maxStaleS) {
            if (frameProvider.getLastFrameData() == null) {
                log.debug("tick $currentTick: warming up (${"%.1f".format(sinceStart)}s), no frames yet")
                return
            }
        }

        val staleness = frameProvider.frameStaleness()
        log.debug("tick $currentTick: staleness=${"%.1f".format(staleness)}s (max=${"%.1f".format(maxStaleS)}s) streamActive=${frameProvider.isStreamActive}")

        // Staleness restart — fire-and-forget
        if (staleness > maxStaleS) {
            val sinceLast = (System.currentTimeMillis() - lastStaleRestart) / 1000.0
            if (staleRestartCount < config.maxStaleRestarts && sinceLast > config.staleRestartCooldownS) {
                staleRestartCount++
                lastStaleRestart = System.currentTimeMillis()
                val staleStr = if (staleness.isFinite()) "${staleness.toInt()}" else "inf"
                log.warn("stale frame (${staleStr}s), restart $staleRestartCount/${config.maxStaleRestarts}")
                frameProvider.requestStreamRestart()
            }
        }

        val frameData = frameProvider.getLastFrameData()
        if (frameData == null) {
            log.debug("tick $currentTick: no frame for analysis, skipping")
            return
        }

        // Reset stale tracking on successful frame read
        staleRestartCount = 0

        // Run analysis + gate + vision + gateway
        processing = true
        try {
            // Frame analysis
            val analysis = analyzer.analyze(frameData)
            if (analysis == null) {
                log.warn("tick: frame analysis returned nil")
                return
            }

            // Scene gate
            val gateResult = gate.classify(analysis)
            log.debug("gate: ${gateResult.classification.value} — ${gateResult.reason}")

            if (gateResult.classification == FrameClass.DROP) {
                return
            }

            gate.markProcessing()

            // Get base64 for vision API
            val base64 = frameProvider.getFrameBase64()
            if (base64 == null) {
                log.warn("tick: no base64 frame available")
                return
            }

            // Vision API
            var description = ""
            var ocrText = ""

            if (config.openRouterApiKey.isNotEmpty()) {
                val result = vision.analyzeFrame(
                    base64Jpeg = base64,
                    apiKey = config.openRouterApiKey,
                    model = config.visionModel,
                    timeoutMs = config.visionTimeoutMs,
                    classification = gateResult.classification
                )
                description = result.description
                ocrText = result.ocrText
            }

            // Prefer native OCR if available
            if (analysis.nativeOcrText.isNotEmpty()) {
                ocrText = analysis.nativeOcrText
            }

            log.info("vision result: desc=${description.length}chars ocr=${ocrText.length}chars")

            if (description.isEmpty() && ocrText.isEmpty()) {
                log.debug("tick: empty vision + ocr, skipping")
                return
            }

            // Build observation
            observation.add(
                description = description,
                ocrText = ocrText,
                classification = gateResult.classification
            )

            val message = observation.buildMessage(
                description = description,
                ocrText = ocrText,
                classification = gateResult.classification
            )

            val tick = observation.tick

            // Try gateway first, fallback to direct
            val gwConnected = gateway.isConnected
            val gwCircuitOpen = gateway.isCircuitOpen
            val via = if (gwConnected && !gwCircuitOpen) "gateway" else "direct"
            log.info("tick $tick: sending via $via (gwConn=$gwConnected circuit=${if (gwCircuitOpen) "open" else "closed"})")

            if (gwConnected && !gwCircuitOpen) {
                val key = "bg-${System.currentTimeMillis()}-$tick"
                val response = gateway.sendAgentRpc(message = message, idempotencyKey = key)
                if (!response.isNullOrEmpty()) {
                    watchSync?.sendToWatch(text = response, tick = tick, isStreaming = false, gatewayConnected = true)
                    eventEmitter.emitPipelineResponse(text = response, tick = tick, isStreaming = false)
                } else {
                    // Gateway failed — send vision description directly
                    watchSync?.sendToWatch(text = description, tick = tick, isStreaming = false, gatewayConnected = false)
                    eventEmitter.emitPipelineResponse(text = description, tick = tick, isStreaming = false)
                }
            } else {
                // No gateway — send vision description directly
                watchSync?.sendToWatch(text = description, tick = tick, isStreaming = false, gatewayConnected = false)
                eventEmitter.emitPipelineResponse(text = description, tick = tick, isStreaming = false)
            }

            // Emit final status
            eventEmitter.emitPipelineStatus(
                gatewayStatus = if (gateway.isConnected) "connected" else "disconnected",
                rpcStatus = "received",
                tick = tick
            )
        } finally {
            processing = false
            gate.markDone()
        }
    }
}
