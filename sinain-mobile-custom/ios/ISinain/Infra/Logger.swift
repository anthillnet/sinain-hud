import Foundation

/// Structured logger — replaces scattered `print("[Component]...")` calls.
struct PipelineLogger {
    let subsystem: String

    func debug(_ message: String) {
        print("[\(subsystem)] \(message)")
    }

    func info(_ message: String) {
        print("[\(subsystem)] \(message)")
    }

    func warn(_ message: String) {
        print("[\(subsystem)] WARN: \(message)")
    }

    func error(_ message: String) {
        print("[\(subsystem)] ERROR: \(message)")
    }
}
