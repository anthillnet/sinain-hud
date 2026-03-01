import Foundation

/// Pipeline orchestrator — runs the frame -> analysis -> gate -> vision -> gateway loop.
///
/// All dependencies injected via protocols. Runs on a dedicated background DispatchQueue
/// using a DispatchSourceTimer — never touches the main thread.
///
/// Tick flow:
///   1. Guard running + not processing
///   2. Get frame from FrameProviding
///   3. Check staleness -> request stream restart if stale
///   4. await analyzer.analyze(frameData) -> FrameAnalysis
///   5. gate.classify(analysis) -> GateResult
///   6. If DROP -> return
///   7. gate.markProcessing(); set processing flag
///   8. await vision.analyzeFrame(...) -> VisionResult
///   9. observation.add(...) + buildMessage(...) -> markdown
///  10. await gateway.sendAgentRpc(message, key) -> response
///  11. Emit response via EventEmitting
///  12. Send to watch via WatchSyncing
///  13. Clear processing flag; gate.markDone()
final class PipelineOrchestrator {

    private(set) var isRunning = false

    // Injected dependencies (all protocols)
    private let frameProvider: FrameProviding
    private let analyzer: FrameAnalyzing
    private let gate: SceneGating
    private let vision: VisionAnalyzing
    private let observation: ObservationBuilding
    private let gateway: GatewayConnecting
    private let eventEmitter: EventEmitting
    private let watchSync: WatchSyncing?
    private let config: PipelineConfig

    private let log = PipelineLogger(subsystem: "Pipeline")

    // Timer + queue
    private let pipelineQueue = DispatchQueue(label: "com.isinain.pipeline", qos: .userInitiated)
    private var timer: DispatchSourceTimer?
    private var processing = false
    private var startTime: Date = .distantPast

    // Staleness restart tracking
    private var staleRestartCount = 0
    private var lastStaleRestart: Date = .distantPast

    init(
        frameProvider: FrameProviding,
        analyzer: FrameAnalyzing,
        gate: SceneGating,
        vision: VisionAnalyzing,
        observation: ObservationBuilding,
        gateway: GatewayConnecting,
        eventEmitter: EventEmitting,
        watchSync: WatchSyncing?,
        config: PipelineConfig
    ) {
        self.frameProvider = frameProvider
        self.analyzer = analyzer
        self.gate = gate
        self.vision = vision
        self.observation = observation
        self.gateway = gateway
        self.eventEmitter = eventEmitter
        self.watchSync = watchSync
        self.config = config
    }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        isRunning = true
        processing = false
        startTime = Date()
        staleRestartCount = 0
        lastStaleRestart = .distantPast

        // Create timer on background queue
        let source = DispatchSource.makeTimerSource(queue: pipelineQueue)
        source.schedule(
            deadline: .now(),
            repeating: config.tickIntervalS,
            leeway: .milliseconds(100)
        )
        source.setEventHandler { [weak self] in
            self?.tick()
        }
        timer = source
        source.resume()

        log.info("started (interval=\(config.tickIntervalS)s)")

        // Notify watch that pipeline is active
        watchSync?.sendToWatch(
            text: "Pipeline active — processing every \(Int(config.tickIntervalS))s",
            tick: 0,
            isStreaming: false,
            gatewayConnected: gateway.isConnected
        )
    }

    func stop() {
        guard isRunning else {
            log.debug("stop called but not running")
            return
        }

        let finalTick = observation.tick
        log.info("stopping (finalTick=\(finalTick))")

        isRunning = false
        timer?.cancel()
        timer = nil
        processing = false
        staleRestartCount = 0
        lastStaleRestart = .distantPast

        log.info("stopped")
    }

    // MARK: - Tick (runs on pipelineQueue)

    private func tick() {
        guard isRunning, !processing else {
            if processing {
                log.debug("tick skipped: still processing previous")
            }
            return
        }

        let currentTick = observation.tick
        let maxStaleS = config.maxStalenessS

        // Warm-up: pipeline just started, no frames expected yet
        let sinceStart = Date().timeIntervalSince(startTime)
        if sinceStart < maxStaleS {
            guard frameProvider.getLastFrameData() != nil else {
                log.debug("tick \(currentTick): warming up (\(String(format: "%.1f", sinceStart))s), no frames yet")
                return
            }
        }

        let staleness = frameProvider.frameStaleness()
        log.debug("tick \(currentTick): staleness=\(String(format: "%.1f", staleness))s (max=\(String(format: "%.1f", maxStaleS))s) streamActive=\(frameProvider.isStreamActive)")

        // Staleness restart — fire-and-forget, never blocks
        if staleness > maxStaleS {
            let sinceLast = Date().timeIntervalSince(lastStaleRestart)
            if staleRestartCount < config.maxStaleRestarts && sinceLast > config.staleRestartCooldownS {
                staleRestartCount += 1
                lastStaleRestart = Date()
                log.warn("stale frame (\(staleness.isFinite ? "\(Int(staleness))" : "inf")s), restart \(staleRestartCount)/\(config.maxStaleRestarts)")
                frameProvider.requestStreamRestart()
            }
        }

        guard let frameData = frameProvider.getLastFrameData() else {
            log.debug("tick \(currentTick): no frame for analysis, skipping")
            return
        }

        // Reset stale tracking on successful frame read
        staleRestartCount = 0

        // Run analysis + gate + vision + gateway async
        processing = true

        Task {
            defer {
                self.processing = false
                self.gate.markDone()
            }

            // Frame analysis (background queue, async)
            guard let analysis = await analyzer.analyze(frameData) else {
                log.warn("tick: frame analysis returned nil")
                return
            }

            // Scene gate
            let gateResult = gate.classify(analysis)
            log.debug("gate: \(gateResult.classification.rawValue) — \(gateResult.reason)")

            if gateResult.classification == .drop {
                return
            }

            gate.markProcessing()

            // Get base64 for vision API
            guard let base64 = frameProvider.getFrameBase64() else {
                log.warn("tick: no base64 frame available")
                return
            }

            // Vision API
            var description = ""
            var ocrText = ""

            if !config.openRouterApiKey.isEmpty {
                let result = await vision.analyzeFrame(
                    base64Jpeg: base64,
                    apiKey: config.openRouterApiKey,
                    model: config.visionModel,
                    timeoutMs: config.visionTimeoutMs,
                    classification: gateResult.classification
                )
                description = result.description
                ocrText = result.ocrText
            }

            // Prefer native OCR if available
            if !analysis.nativeOcrText.isEmpty {
                ocrText = analysis.nativeOcrText
            }

            log.info("vision result: desc=\(description.count)chars ocr=\(ocrText.count)chars")

            guard !description.isEmpty || !ocrText.isEmpty else {
                log.debug("tick: empty vision + ocr, skipping")
                return
            }

            // Build observation
            observation.add(
                description: description,
                ocrText: ocrText,
                classification: gateResult.classification
            )

            let message = observation.buildMessage(
                description: description,
                ocrText: ocrText,
                classification: gateResult.classification
            )

            let tick = observation.tick

            // Try gateway first, fallback to direct
            let gwConnected = gateway.isConnected
            let gwCircuitOpen = gateway.isCircuitOpen
            log.info("tick \(tick): sending via \(gwConnected && !gwCircuitOpen ? "gateway" : "direct") (gwConn=\(gwConnected) circuit=\(gwCircuitOpen ? "open" : "closed"))")

            if gwConnected && !gwCircuitOpen {
                let key = "bg-\(Int(Date().timeIntervalSince1970 * 1000))-\(tick)"
                let response = await gateway.sendAgentRpc(message: message, idempotencyKey: key)
                if let response = response, !response.isEmpty {
                    watchSync?.sendToWatch(text: response, tick: tick, isStreaming: false, gatewayConnected: true)
                    eventEmitter.emitPipelineResponse(text: response, tick: tick, isStreaming: false)
                } else {
                    // Gateway failed — send vision description directly
                    watchSync?.sendToWatch(text: description, tick: tick, isStreaming: false, gatewayConnected: false)
                    eventEmitter.emitPipelineResponse(text: description, tick: tick, isStreaming: false)
                }
            } else {
                // No gateway — send vision description directly
                watchSync?.sendToWatch(text: description, tick: tick, isStreaming: false, gatewayConnected: false)
                eventEmitter.emitPipelineResponse(text: description, tick: tick, isStreaming: false)
            }

            // Emit final status
            eventEmitter.emitPipelineStatus(
                gatewayStatus: gateway.isConnected ? "connected" : "disconnected",
                rpcStatus: "received",
                tick: tick
            )
        }
    }
}
