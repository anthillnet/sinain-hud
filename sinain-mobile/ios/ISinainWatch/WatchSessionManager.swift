import Foundation
import WatchConnectivity
import Combine

final class WatchSessionManager: NSObject, ObservableObject {
    static let shared = WatchSessionManager()

    @Published var messages: [WatchMessage] = []
    @Published var pipelineStatus: WatchPipelineStatus = WatchPipelineStatus(
        gatewayStatus: "disconnected",
        lastRpcStatus: "idle",
        isStreaming: false,
        tick: 0
    )
    @Published var isPhoneReachable = false
    @Published var isBackgroundMode = false
    @Published var lastUpdated: Date?

    private static let messagesKey = "cached_messages"
    private static let statusKey = "cached_status"
    private var lastAcceptedTick: Int = 0

    private override init() {
        super.init()
        restoreFromCache()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private func processPayload(_ payload: [String: Any]) {
        let incomingTick: Int
        if let statusDict = payload["status"] as? [String: Any] {
            incomingTick = statusDict["tick"] as? Int ?? 0
        } else {
            incomingTick = 0
        }

        if incomingTick > 0 && incomingTick < lastAcceptedTick {
            print("[WatchSession] dropping stale payload (tick \(incomingTick) < \(lastAcceptedTick))")
            return
        }
        lastAcceptedTick = max(lastAcceptedTick, incomingTick)
        let bgMode = (payload["status"] as? [String: Any])?["backgroundMode"] as? Bool ?? false
        print("[WatchSession] accepted tick \(incomingTick) (lastAccepted=\(lastAcceptedTick), bg=\(bgMode))")

        if let messagesArray = payload["messages"] as? [[String: Any]] {
            let decoded = messagesArray.compactMap { dict -> WatchMessage? in
                guard let id = dict["id"] as? String,
                      let text = dict["text"] as? String,
                      let isStreaming = dict["isStreaming"] as? Bool,
                      let timestamp = dict["timestamp"] as? Double else {
                    return nil
                }
                return WatchMessage(id: id, text: text, isStreaming: isStreaming, timestamp: timestamp)
            }
            DispatchQueue.main.async {
                self.messages = decoded
                self.lastUpdated = Date()
            }
            if let data = try? JSONEncoder().encode(decoded) {
                UserDefaults.standard.set(data, forKey: Self.messagesKey)
            }
        }

        if let statusDict = payload["status"] as? [String: Any] {
            let gatewayStatus = statusDict["gatewayStatus"] as? String ?? "disconnected"
            let lastRpcStatus = statusDict["lastRpcStatus"] as? String ?? "idle"
            let isStreaming = statusDict["isStreaming"] as? Bool ?? false
            let tick = statusDict["tick"] as? Int ?? 0
            let backgroundMode = statusDict["backgroundMode"] as? Bool ?? false

            let status = WatchPipelineStatus(
                gatewayStatus: gatewayStatus,
                lastRpcStatus: lastRpcStatus,
                isStreaming: isStreaming,
                tick: tick
            )
            DispatchQueue.main.async {
                self.pipelineStatus = status
                self.isBackgroundMode = backgroundMode
            }
            if let data = try? JSONEncoder().encode(status) {
                UserDefaults.standard.set(data, forKey: Self.statusKey)
            }
        }
    }

    private func restoreFromCache() {
        if let data = UserDefaults.standard.data(forKey: Self.messagesKey),
           let cached = try? JSONDecoder().decode([WatchMessage].self, from: data) {
            messages = cached
        }
        if let data = UserDefaults.standard.data(forKey: Self.statusKey),
           let cached = try? JSONDecoder().decode(WatchPipelineStatus.self, from: data) {
            pipelineStatus = cached
        }
    }
}

// MARK: - WCSessionDelegate
extension WatchSessionManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isPhoneReachable = session.isReachable
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        print("[WatchSession] didReceiveMessage (live)")
        processPayload(message)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        print("[WatchSession] didReceiveMessage (with reply)")
        processPayload(message)
        replyHandler(["ack": true])
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        print("[WatchSession] didReceiveApplicationContext")
        processPayload(applicationContext)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        print("[WatchSession] didReceiveUserInfo")
        processPayload(userInfo)
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        print("[WatchSession] phone reachability: \(session.isReachable)")
        DispatchQueue.main.async {
            self.isPhoneReachable = session.isReachable
        }
    }
}
