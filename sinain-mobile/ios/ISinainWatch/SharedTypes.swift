import Foundation

struct WatchMessage: Identifiable, Codable {
    let id: String
    let text: String
    let isStreaming: Bool
    let timestamp: Double

    var displayTime: String {
        guard timestamp > 0 else { return "" }
        let date = Date(timeIntervalSince1970: timestamp / 1000.0)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }
}

struct WatchPipelineStatus: Codable {
    let gatewayStatus: String
    let lastRpcStatus: String
    let isStreaming: Bool
    let tick: Int
}
