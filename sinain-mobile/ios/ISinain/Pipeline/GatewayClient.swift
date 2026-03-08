import Foundation

/// WebSocket gateway client for OpenClaw agent RPC.
///
/// Protocol:
///  1. Server sends connect.challenge event
///  2. Client responds with connect request + auth token
///  3. Client sends 'agent' RPC, server replies with accepted (intermediate) then final response
///  4. Reconnect with exponential backoff on disconnect
///  5. Circuit breaker: 5 failures in 2min -> open for 5min, progressive backoff up to 30min
final class GatewayClient: GatewayConnecting {
    typealias StatusCallback = (String) -> Void
    typealias ResponseCallback = (String) -> Void

    var onStatusChange: StatusCallback?
    var onResponse: ResponseCallback?

    private let wsUrl: String
    private let token: String
    private let sessionKey: String
    private let log = PipelineLogger(subsystem: "GatewayClient")

    private var urlSession: URLSession?
    private var wsTask: URLSessionWebSocketTask?
    private var authenticated = false
    private var rpcId = 1
    private var closing = false
    private var pendingRunId: String?

    // Pending RPCs
    private struct PendingRpc {
        let continuation: CheckedContinuation<String?, Never>
        var timer: DispatchWorkItem?
        let expectFinal: Bool
    }
    private var pending: [String: PendingRpc] = [:]

    // Reconnect backoff
    private var reconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 60.0
    private var reconnectWorkItem: DispatchWorkItem?

    // Circuit breaker
    private var recentFailures: [Date] = []
    private var circuitOpenFlag = false
    private var circuitResetWorkItem: DispatchWorkItem?
    private let circuitThreshold = 5
    private let circuitWindowS: TimeInterval = 120
    private var circuitResetDelay: TimeInterval = 300
    private let maxCircuitReset: TimeInterval = 1800

    var isConnected: Bool {
        wsTask != nil && authenticated
    }

    var isCircuitOpen: Bool {
        circuitOpenFlag
    }

    init(wsUrl: String, token: String, sessionKey: String) {
        self.wsUrl = wsUrl
        self.token = token
        self.sessionKey = sessionKey
    }

    // MARK: - Public API

    func start() {
        guard !closing else { return }
        connect()
    }

    func sendAgentRpc(message: String, idempotencyKey: String) async -> String? {
        if circuitOpenFlag {
            log.warn("circuit breaker open, skipping RPC")
            return nil
        }
        guard isConnected else {
            log.warn("not connected, cannot send RPC")
            return nil
        }

        let id = String(rpcId)
        rpcId += 1

        return await withCheckedContinuation { continuation in
            let timeoutWork = DispatchWorkItem { [weak self] in
                guard let self = self, self.pending[id] != nil else { return }
                self.pending.removeValue(forKey: id)
                self.onRpcFailure()
                continuation.resume(returning: nil)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeoutWork)

            pending[id] = PendingRpc(
                continuation: continuation,
                timer: timeoutWork,
                expectFinal: true
            )

            self.pendingRunId = idempotencyKey

            let payload: [String: Any] = [
                "type": "req",
                "method": "agent",
                "id": id,
                "params": [
                    "message": message,
                    "sessionKey": sessionKey,
                    "idempotencyKey": idempotencyKey,
                    "deliver": false,
                ],
            ]

            sendJson(payload)
            log.info("agent RPC sent (id=\(id)): \(String(message.prefix(100)))")
        }
    }

    func close() {
        closing = true
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        circuitResetWorkItem?.cancel()
        circuitResetWorkItem = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        onDisconnect()
    }

    // MARK: - Connection

    private func connect() {
        guard !closing, !circuitOpenFlag else { return }
        onStatusChange?("connecting")
        log.info("connecting to \(wsUrl)")

        guard let url = URL(string: wsUrl) else {
            log.error("invalid URL: \(wsUrl)")
            scheduleReconnect()
            return
        }

        let session = URLSession(configuration: .default)
        urlSession = session
        let task = session.webSocketTask(with: url)
        wsTask = task
        task.resume()

        log.info("ws connected (awaiting challenge)")
        receiveMessage()
    }

    private func receiveMessage() {
        wsTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.handleMessage(json)
                    }
                case .data(let data):
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.handleMessage(json)
                    }
                @unknown default:
                    break
                }
                self.receiveMessage()

            case .failure(let error):
                self.log.error("receive error: \(error)")
                self.wsTask = nil
                self.urlSession?.invalidateAndCancel()
                self.urlSession = nil
                self.onDisconnect()
                if !self.closing { self.scheduleReconnect() }
            }
        }
    }

    // MARK: - Message Handling

    private func handleMessage(_ msg: [String: Any]) {
        let type = msg["type"] as? String ?? ""

        // 1. Handle connect.challenge
        if type == "event", (msg["event"] as? String) == "connect.challenge" {
            log.info("received challenge, authenticating...")
            sendJson([
                "type": "req",
                "id": "connect-1",
                "method": "connect",
                "params": [
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": [
                        "id": "gateway-client",
                        "displayName": "ISinain Mobile (Native)",
                        "version": "1.0.0",
                        "platform": "ios",
                        "mode": "backend",
                    ] as [String: Any],
                    "auth": ["token": token],
                ] as [String: Any],
            ])
            return
        }

        // 2. Handle connect response (auth result)
        if type == "res", (msg["id"] as? String) == "connect-1" {
            if msg["ok"] as? Bool == true {
                authenticated = true
                reconnectDelay = 1.0
                log.info("authenticated")
                onStatusChange?("connected")
            } else {
                let err = msg["error"] ?? "unknown auth error"
                log.error("auth failed: \(err)")
                reconnectDelay = max(reconnectDelay, 30)
                wsTask?.cancel(with: .normalClosure, reason: nil)
                wsTask = nil
                urlSession?.invalidateAndCancel()
                urlSession = nil
            }
            return
        }

        // 3. Handle streaming events (filter by runId to prevent cross-talk)
        if type == "event", (msg["event"] as? String) == "agent" {
            if let payload = msg["payload"] as? [String: Any] {
                // Only process events matching our pending RPC
                let eventRunId = payload["runId"] as? String
                guard eventRunId == pendingRunId else { return }

                if (payload["stream"] as? String) == "assistant",
                   let data = payload["data"] as? [String: Any],
                   let text = data["text"] as? String {
                    onResponse?(text)
                }
            }
            return
        }

        // 4. Ignore other events
        if type == "event" { return }

        // 5. Handle RPC responses
        let msgId: String?
        if let intId = msg["id"] as? Int {
            msgId = String(intId)
        } else {
            msgId = msg["id"] as? String
        }

        if type == "res", let id = msgId, let pendingRpc = pending[id] {
            let payload = msg["payload"] as? [String: Any] ?? [:]

            // Skip intermediate "accepted" responses
            if pendingRpc.expectFinal, (payload["status"] as? String) == "accepted" {
                log.debug("rpc \(id): accepted")
                return
            }

            log.debug("rpc \(id): final")
            pendingRpc.timer?.cancel()
            pending.removeValue(forKey: id)

            if msg["ok"] as? Bool == true {
                circuitResetDelay = 300
                let result = payload["result"] as? [String: Any] ?? [:]
                let payloads = result["payloads"] as? [[String: Any]] ?? []
                let texts = payloads.compactMap { $0["text"] as? String }
                var responseText = texts.joined(separator: "\n")

                if responseText.isEmpty,
                   let sentTexts = result["messagingToolSentTexts"] as? [String], !sentTexts.isEmpty {
                    responseText = sentTexts.joined(separator: "\n")
                }

                log.info("payloads: \(payloads.count), text: \(responseText.count) chars")
                if !responseText.isEmpty {
                    onResponse?(responseText)
                }
                pendingRpc.continuation.resume(returning: responseText.isEmpty ? nil : responseText)
            } else {
                let err = msg["error"] ?? "unknown RPC error"
                log.error("agent RPC error: \(err)")
                onRpcFailure()
                pendingRpc.continuation.resume(returning: nil)
            }
            return
        }
    }

    // MARK: - Helpers

    private func sendJson(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { error in
            if let error = error {
                self.log.error("send error: \(error)")
            }
        }
    }

    private func onDisconnect() {
        authenticated = false
        for (_, rpc) in pending {
            rpc.timer?.cancel()
            rpc.continuation.resume(returning: nil)
        }
        pending.removeAll()
        log.info("disconnected")
        onStatusChange?("disconnected")
    }

    private func onRpcFailure() {
        let now = Date()
        recentFailures.append(now)
        let cutoff = now.addingTimeInterval(-circuitWindowS)
        recentFailures = recentFailures.filter { $0 > cutoff }

        if recentFailures.count >= circuitThreshold && !circuitOpenFlag {
            circuitOpenFlag = true
            log.warn("circuit breaker opened after \(recentFailures.count) failures, reset in \(Int(circuitResetDelay))s")

            let resetWork = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.circuitOpenFlag = false
                self.recentFailures.removeAll()
                self.log.info("circuit breaker reset")
                if !self.closing { self.connect() }
            }
            circuitResetWorkItem = resetWork
            DispatchQueue.main.asyncAfter(deadline: .now() + circuitResetDelay, execute: resetWork)
            circuitResetDelay = min(circuitResetDelay * 2, maxCircuitReset)
        }
    }

    private func scheduleReconnect() {
        guard !closing, !circuitOpenFlag else { return }
        log.info("reconnecting in \(String(format: "%.1f", reconnectDelay))s...")

        let work = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + reconnectDelay, execute: work)
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
    }
}
