import Foundation
import React
import WatchConnectivity

/// React Native bridge to WatchConnectivity.
@objc(WatchBridge)
class WatchBridge: RCTEventEmitter, WCSessionDelegate {

    private var hasListeners = false
    private var lastContext: [String: Any]?

    override init() {
        super.init()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { true }

    override func supportedEvents() -> [String] {
        ["onWatchReachabilityChanged"]
    }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Bridge Methods

    @objc
    func updateFeed(_ messages: [[String: Any]],
                    status: NSDictionary,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard WCSession.isSupported() else {
            resolve(false)
            return
        }

        let session = WCSession.default
        guard session.activationState == .activated else {
            resolve(false)
            return
        }

        guard session.isPaired, session.isWatchAppInstalled else {
            resolve(false)
            return
        }

        let payload: [String: Any] = [
            "messages": messages,
            "status": status as? [String: Any] ?? [:]
        ]

        lastContext = payload

        if session.isReachable {
            session.sendMessage(payload, replyHandler: { _ in
                resolve(true)
            }, errorHandler: { [weak self] _ in
                self?.sendViaApplicationContext(payload)
                resolve(true)
            })
        } else {
            sendViaApplicationContext(payload)
            resolve(true)
        }
    }

    private func sendViaApplicationContext(_ payload: [String: Any]) {
        do {
            try WCSession.default.updateApplicationContext(payload)
        } catch {
            print("[WatchBridge] updateApplicationContext error: \(error)")
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        if activationState == .activated {
            print("[WatchBridge] WCSession activated")
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        print("[WatchBridge] reachability changed: \(session.isReachable)")
        if hasListeners {
            sendEvent(withName: "onWatchReachabilityChanged", body: [
                "isReachable": session.isReachable
            ])
        }
    }
}

/// Adapter conforming to WatchSyncing for pipeline injection.
final class WatchSyncAdapter: WatchSyncing {
    private let log = PipelineLogger(subsystem: "WatchSync")

    func sendToWatch(text: String, tick: Int, isStreaming: Bool, gatewayConnected: Bool) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }

        guard session.isPaired, session.isWatchAppInstalled else {
            log.warn("tick \(tick): skipped — paired=\(session.isPaired) installed=\(session.isWatchAppInstalled)")
            return
        }

        log.info("tick \(tick): state=activated paired=true installed=true reachable=\(session.isReachable) textLen=\(text.count)")

        let now = Date().timeIntervalSince1970 * 1000

        let messagePayload: [[String: Any]] = [[
            "id": "bg-tick-\(tick)",
            "text": text,
            "isStreaming": isStreaming,
            "timestamp": now,
        ]]

        let statusPayload: [String: Any] = [
            "gatewayStatus": gatewayConnected ? "connected" : "disconnected",
            "lastRpcStatus": isStreaming ? "streaming" : "received",
            "isStreaming": true,
            "tick": tick,
            "backgroundMode": true,
        ]

        let payload: [String: Any] = [
            "messages": messagePayload,
            "status": statusPayload,
        ]

        do {
            try session.updateApplicationContext(payload)
            log.info("tick \(tick): updateApplicationContext succeeded")
        } catch {
            log.warn("tick \(tick): updateApplicationContext failed — \(error)")
        }
    }
}
