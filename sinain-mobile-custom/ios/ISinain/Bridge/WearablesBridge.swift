import Foundation
import UIKit
import React
import MWDATCore
import MWDATCamera

/// React Native bridge to MWDAT SDK.
/// Conforms to FrameProviding (camera frame access) and EventEmitting (pipeline event dispatch).
/// Much thinner than the original MetaWearablesBridge (~820 lines -> ~400 lines):
/// frame analysis, scene gate, vision, observation, and gateway are all separate components.
@objc(WearablesBridge)
class WearablesBridge: RCTEventEmitter, FrameProviding, EventEmitting {

    private var deviceSelector: AutoDeviceSelector?
    private var session: StreamSession?
    private var listenerTokens: [AnyListenerToken] = []
    private var hasListeners = false

    // Frame data (protected by frameQueue)
    private let frameQueue = DispatchQueue(label: "com.isinain.frame", qos: .userInitiated)
    private var lastFrameDataStorage: Data?
    private var frameCount = 0
    private var fpsTimer: Date = Date()
    private var currentFPS: Int = 0
    private var lastFrameTimestamp: Date = .distantPast

    private var connectionState: String = "idle"
    private var streamState: String = "stopped"

    // Stream auto-restart
    private var lastStreamConfig: StreamSessionConfig?
    private var userWantsStreaming = false
    private var restartAttempts = 0
    private let maxRestartAttempts = 3

    // Pipeline components (owned by this bridge, injected into orchestrator)
    private var config: PipelineConfig?
    private var gatewayClient: GatewayClient?
    private var orchestrator: PipelineOrchestrator?

    private let log = PipelineLogger(subsystem: "WearablesBridge")

    private let frameDir: URL = {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mwdat", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private var frameFileURL: URL {
        frameDir.appendingPathComponent("frame.jpg")
    }

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String] {
        ["onFrame", "onState", "onError", "onPipelineResponse", "onPipelineStatus"]
    }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Bridge Methods

    @objc
    func configure(_ dict: NSDictionary,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        // Store config synchronously (fixes config race from original)
        let pipelineConfig = PipelineConfig(from: dict)
        self.config = pipelineConfig

        log.info("configure: token=\(pipelineConfig.gatewayToken.isEmpty ? "EMPTY" : "present(\(pipelineConfig.gatewayToken.count)chars)") ws=\(pipelineConfig.gatewayWsUrl)")

        // BUG-2 FIX: Create gateway eagerly, independent of streaming state
        if gatewayClient == nil && !pipelineConfig.gatewayToken.isEmpty {
            let gw = GatewayClient(
                wsUrl: pipelineConfig.gatewayWsUrl,
                token: pipelineConfig.gatewayToken,
                sessionKey: pipelineConfig.sessionKey
            )
            gw.onStatusChange = { [weak self] status in
                self?.emitPipelineStatus(
                    gatewayStatus: status,
                    rpcStatus: "idle",
                    tick: self?.orchestrator?.isRunning == true ? (self?.orchestratorTick ?? 0) : 0
                )
            }
            gw.onResponse = { [weak self] text in
                let tick = self?.orchestratorTick ?? 0
                self?.emitPipelineResponse(text: text, tick: tick, isStreaming: true)
            }
            gatewayClient = gw
            gw.start()
            log.info("gateway started eagerly (url=\(pipelineConfig.gatewayWsUrl))")
        }

        resolve(true)
    }

    @objc
    func startRegistration(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let currentState = Wearables.shared.registrationState
                if currentState == .registered {
                    self.updateState(connection: "registered", stream: self.streamState)
                    resolve(nil)
                    return
                }

                try await Wearables.shared.startRegistration()

                let timeout = Task {
                    try await Task.sleep(nanoseconds: 60_000_000_000)
                    return true
                }

                for await state in Wearables.shared.registrationStateStream() {
                    if state == .registered {
                        timeout.cancel()
                        self.updateState(connection: "registered", stream: self.streamState)
                        resolve(nil)
                        return
                    }
                }

                if !timeout.isCancelled {
                    resolve(nil)
                }
            } catch {
                reject("REGISTRATION_ERROR", "\(error)", error)
            }
        }
    }

    @objc
    func startStream(_ config: NSDictionary,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in
            do {
                // Camera permission
                do {
                    let status = try await Wearables.shared.checkPermissionStatus(.camera)
                    if status != .granted {
                        let result = try await Wearables.shared.requestPermission(.camera)
                        guard result == .granted else {
                            reject("PERMISSION_DENIED", "Camera permission denied", nil)
                            return
                        }
                    }
                } catch {
                    self.log.warn("Permission check error: \(error) - proceeding anyway")
                }

                let resolutionStr = config["resolution"] as? String ?? "medium"
                let frameRate = config["frameRate"] as? Int ?? 24

                let resolution: StreamingResolution
                switch resolutionStr {
                case "low": resolution = .low
                case "high": resolution = .high
                default: resolution = .medium
                }

                let streamConfig = StreamSessionConfig(
                    videoCodec: .raw,
                    resolution: resolution,
                    frameRate: UInt(frameRate)
                )

                self.lastStreamConfig = streamConfig
                self.userWantsStreaming = true
                self.restartAttempts = 0
                self.log.info("startStream: resolution=\(resolutionStr) fps=\(frameRate)")

                let selector = AutoDeviceSelector(wearables: Wearables.shared)
                self.deviceSelector = selector

                let streamSession = StreamSession(
                    streamSessionConfig: streamConfig,
                    deviceSelector: selector
                )
                self.session = streamSession

                // Reset FPS tracking
                frameQueue.sync {
                    self.frameCount = 0
                    self.fpsTimer = Date()
                    self.currentFPS = 0
                    self.lastFrameDataStorage = nil
                    self.lastFrameTimestamp = .distantPast
                }

                // Subscribe BEFORE starting
                let frameToken = streamSession.videoFramePublisher.listen { [weak self] frame in
                    self?.handleFrame(frame)
                }
                listenerTokens.append(frameToken)

                let stateToken = streamSession.statePublisher.listen { [weak self] state in
                    self?.handleStreamState(state)
                }
                listenerTokens.append(stateToken)

                let errorToken = streamSession.errorPublisher.listen { [weak self] error in
                    let detail: String
                    switch error {
                    case .internalError: detail = "internalError (generic catch-all)"
                    case .deviceNotFound(let id): detail = "deviceNotFound(\(id))"
                    case .deviceNotConnected(let id): detail = "deviceNotConnected(\(id))"
                    case .timeout: detail = "timeout"
                    case .videoStreamingError: detail = "videoStreamingError"
                    case .audioStreamingError: detail = "audioStreamingError"
                    case .permissionDenied: detail = "permissionDenied"
                    case .hingesClosed: detail = "hingesClosed"
                    @unknown default: detail = "unknown(\(error))"
                    }
                    self?.log.warn("StreamSession error: \(detail)")
                    self?.emitError(code: "STREAM_SESSION_ERROR", message: detail)
                }
                listenerTokens.append(errorToken)

                self.updateState(connection: "connected", stream: "starting")

                // Diagnostic: dump SDK state before start
                let devices = Wearables.shared.devices
                self.log.info("PRE-START: \(devices.count) device(s) registered, registrationState=\(Wearables.shared.registrationState)")
                for deviceId in devices {
                    if let device = Wearables.shared.deviceForIdentifier(deviceId) {
                        self.log.info("  device[\(device.nameOrId())]: link=\(device.linkState), type=\(device.deviceType()), compat=\(device.compatibility())")
                    } else {
                        self.log.warn("  device[\(deviceId)]: deviceForIdentifier returned nil")
                    }
                }
                self.log.info("PRE-START: selector.activeDevice=\(String(describing: selector.activeDevice))")

                await streamSession.start()

                resolve(nil)
            } catch {
                self.emitError(code: "STREAM_ERROR", message: "\(error)")
                reject("STREAM_ERROR", "\(error)", error)
            }
        }
    }

    @objc
    func stopStream(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in
            self.log.info("stopStream: tearing down session")
            self.userWantsStreaming = false
            // Stop pipeline (but NOT gateway — BUG-2 fix: gateway survives stream stop)
            orchestrator?.stop()
            orchestrator = nil
            if let session = self.session {
                await session.stop()
            }
            self.session = nil
            self.listenerTokens.removeAll()
            self.deviceSelector = nil
            frameQueue.sync { self.lastFrameDataStorage = nil }
            self.updateState(connection: connectionState, stream: "stopped")
            resolve(nil)
        }
    }

    @objc
    func capturePhoto(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        let jpegData: Data? = frameQueue.sync { self.lastFrameDataStorage }

        guard let jpegData = jpegData else {
            reject("NO_FRAME", "No frame available to capture", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            let photoURL = self.frameDir.appendingPathComponent("photo_\(timestamp).jpg")

            if let uiImage = UIImage(data: jpegData),
               let highQualityData = uiImage.jpegData(compressionQuality: 0.92) {
                do {
                    try highQualityData.write(to: photoURL)
                    let size = uiImage.size
                    DispatchQueue.main.async {
                        resolve([
                            "uri": photoURL.absoluteString,
                            "width": Int(size.width),
                            "height": Int(size.height)
                        ])
                    }
                } catch {
                    DispatchQueue.main.async {
                        reject("PHOTO_ERROR", error.localizedDescription, error)
                    }
                }
            } else {
                DispatchQueue.main.async {
                    reject("PHOTO_ERROR", "Failed to encode photo", nil)
                }
            }
        }
    }

    @objc
    func getState(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve([
            "connection": connectionState,
            "stream": streamState
        ])
    }

    // MARK: - FrameProviding

    func getLastFrameData() -> Data? {
        frameQueue.sync { lastFrameDataStorage }
    }

    func getFrameBase64() -> String? {
        guard let data = getLastFrameData() else { return nil }
        return data.base64EncodedString()
    }

    func frameStaleness() -> TimeInterval {
        frameQueue.sync {
            guard lastFrameDataStorage != nil else { return .infinity }
            return Date().timeIntervalSince(lastFrameTimestamp)
        }
    }

    var isStreamActive: Bool {
        streamState == "streaming"
    }

    func requestStreamRestart() {
        Task { @MainActor in
            await self.restartStreamInternal()
        }
    }

    // MARK: - EventEmitting

    func emitPipelineResponse(text: String, tick: Int, isStreaming: Bool) {
        guard hasListeners else { return }
        DispatchQueue.main.async {
            self.sendEvent(withName: "onPipelineResponse", body: [
                "text": text, "tick": tick, "isStreaming": isStreaming,
                "timestamp": Date().timeIntervalSince1970 * 1000
            ])
        }
    }

    func emitPipelineStatus(gatewayStatus: String, rpcStatus: String, tick: Int) {
        guard hasListeners else { return }
        DispatchQueue.main.async {
            self.sendEvent(withName: "onPipelineStatus", body: [
                "gatewayStatus": gatewayStatus, "rpcStatus": rpcStatus, "tick": tick
            ])
        }
    }

    // MARK: - Frame Handling

    private func handleFrame(_ frame: VideoFrame) {
        frameQueue.async { [weak self] in
            guard let self = self else { return }

            guard let uiImage = frame.makeUIImage(),
                  let jpegData = uiImage.jpegData(compressionQuality: 0.85) else { return }

            try? jpegData.write(to: self.frameFileURL)
            self.lastFrameDataStorage = jpegData
            self.lastFrameTimestamp = Date()

            self.frameCount += 1
            let elapsed = Date().timeIntervalSince(self.fpsTimer)
            if elapsed >= 1.0 {
                self.currentFPS = self.frameCount
                self.frameCount = 0
                self.fpsTimer = Date()
            }

            let width = Int(uiImage.size.width)
            let height = Int(uiImage.size.height)
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            let fps = self.currentFPS

            DispatchQueue.main.async {
                guard self.hasListeners else { return }
                self.sendEvent(withName: "onFrame", body: [
                    "uri": self.frameFileURL.absoluteString,
                    "width": width,
                    "height": height,
                    "fps": fps,
                    "timestamp": timestamp
                ])
            }
        }
    }

    private func handleStreamState(_ state: StreamSessionState) {
        let previousStreamState = streamState
        let stateStr: String
        switch state {
        case .streaming: stateStr = "streaming"
        case .stopped: stateStr = "stopped"
        case .stopping: stateStr = "stopping"
        case .starting: stateStr = "starting"
        case .waitingForDevice: stateStr = "waitingForDevice"
        case .paused: stateStr = "paused"
        @unknown default: stateStr = "unknown"
        }
        log.info("stream state: \(previousStreamState) -> \(stateStr) (userWants=\(userWantsStreaming))")
        if let activeId = deviceSelector?.activeDevice,
           let device = Wearables.shared.deviceForIdentifier(activeId) {
            log.info("  activeDevice: \(device.nameOrId()) link=\(device.linkState) compat=\(device.compatibility())")
        } else {
            log.info("  activeDevice: nil (selector=\(deviceSelector != nil ? "exists" : "nil"))")
        }
        updateState(connection: connectionState, stream: stateStr)

        if stateStr == "streaming" {
            restartAttempts = 0
            // BUG-1 FIX: Pipeline starts ONLY after "streaming" state is confirmed
            startPipelineIfNeeded()
        } else if previousStreamState == "streaming" && userWantsStreaming {
            scheduleStreamRestart()
        }
    }

    // MARK: - Pipeline Lifecycle

    /// Creates PipelineOrchestrator with all DI components and starts it.
    /// Called ONLY after "streaming" state — never during startStream().
    private func startPipelineIfNeeded() {
        guard orchestrator == nil || orchestrator?.isRunning != true else { return }
        guard let config = self.config else {
            log.warn("cannot start pipeline: no config")
            return
        }

        let analyzer = FrameAnalyzer()
        let gate = SceneGate(config: config.sceneGate)
        let vision = VisionClient()
        let observation = ObservationBuilder(
            maxEntries: config.observationMaxEntries,
            maxAgeS: config.observationMaxAgeS
        )

        // Use existing gateway (already started in configure())
        let gw = self.gatewayClient ?? {
            // Fallback: create gateway if somehow missing
            let newGw = GatewayClient(
                wsUrl: config.gatewayWsUrl,
                token: config.gatewayToken,
                sessionKey: config.sessionKey
            )
            self.gatewayClient = newGw
            newGw.start()
            return newGw
        }()

        let watchAdapter = WatchSyncAdapter()

        let pipeline = PipelineOrchestrator(
            frameProvider: self,
            analyzer: analyzer,
            gate: gate,
            vision: vision,
            observation: observation,
            gateway: gw,
            eventEmitter: self,
            watchSync: watchAdapter,
            config: config
        )
        orchestrator = pipeline
        pipeline.start()
        log.info("pipeline orchestrator started with DI components")
    }

    // MARK: - Stream Restart

    private func scheduleStreamRestart() {
        guard restartAttempts < maxRestartAttempts else {
            log.warn("max restart attempts (\(maxRestartAttempts)) reached")
            return
        }
        let delay = Double(restartAttempts + 1) * 2.0
        restartAttempts += 1
        log.info("scheduling stream restart in \(delay)s (attempt \(restartAttempts)/\(maxRestartAttempts))")

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            Task { @MainActor in
                await self?.restartStreamInternal()
            }
        }
    }

    @MainActor
    private func restartStreamInternal() async {
        guard userWantsStreaming, let config = lastStreamConfig else { return }

        if let oldSession = session {
            await oldSession.stop()
        }
        listenerTokens.removeAll()

        let selector = AutoDeviceSelector(wearables: Wearables.shared)
        self.deviceSelector = selector

        let streamSession = StreamSession(
            streamSessionConfig: config,
            deviceSelector: selector
        )
        self.session = streamSession

        let frameToken = streamSession.videoFramePublisher.listen { [weak self] frame in
            self?.handleFrame(frame)
        }
        listenerTokens.append(frameToken)

        let stateToken = streamSession.statePublisher.listen { [weak self] state in
            self?.handleStreamState(state)
        }
        listenerTokens.append(stateToken)

        let errorToken = streamSession.errorPublisher.listen { [weak self] error in
            let detail: String
            switch error {
            case .internalError: detail = "internalError (generic catch-all)"
            case .deviceNotFound(let id): detail = "deviceNotFound(\(id))"
            case .deviceNotConnected(let id): detail = "deviceNotConnected(\(id))"
            case .timeout: detail = "timeout"
            case .videoStreamingError: detail = "videoStreamingError"
            case .audioStreamingError: detail = "audioStreamingError"
            case .permissionDenied: detail = "permissionDenied"
            case .hingesClosed: detail = "hingesClosed"
            @unknown default: detail = "unknown(\(error))"
            }
            self?.log.warn("StreamSession error (restart): \(detail)")
            self?.emitError(code: "STREAM_SESSION_ERROR", message: detail)
        }
        listenerTokens.append(errorToken)

        updateState(connection: "connected", stream: "starting")
        log.info("restarting stream (attempt \(restartAttempts))")

        // Diagnostic: dump SDK state before restart
        let devices = Wearables.shared.devices
        log.info("PRE-RESTART: \(devices.count) device(s), registrationState=\(Wearables.shared.registrationState)")
        for deviceId in devices {
            if let device = Wearables.shared.deviceForIdentifier(deviceId) {
                log.info("  device[\(device.nameOrId())]: link=\(device.linkState), type=\(device.deviceType()), compat=\(device.compatibility())")
            } else {
                log.warn("  device[\(deviceId)]: deviceForIdentifier returned nil")
            }
        }
        log.info("PRE-RESTART: selector.activeDevice=\(String(describing: selector.activeDevice))")

        await streamSession.start()
    }

    // MARK: - Helpers

    private var orchestratorTick: Int {
        // Access the observation tick through the orchestrator
        0 // simplified — tick is emitted through events
    }

    private func updateState(connection: String, stream: String) {
        connectionState = connection
        streamState = stream
        guard hasListeners else { return }
        DispatchQueue.main.async {
            self.sendEvent(withName: "onState", body: [
                "connection": connection,
                "stream": stream
            ])
        }
    }

    private func emitError(code: String, message: String) {
        guard hasListeners else { return }
        DispatchQueue.main.async {
            self.sendEvent(withName: "onError", body: [
                "code": code,
                "message": message
            ])
        }
    }
}
