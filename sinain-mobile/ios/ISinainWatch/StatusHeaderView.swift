import SwiftUI

struct StatusHeaderView: View {
    @EnvironmentObject var session: WatchSessionManager

    private var statusColor: Color {
        switch session.pipelineStatus.gatewayStatus {
        case "connected": return .green
        case "connecting": return .orange
        case "disconnected": return .red
        case "error": return .red
        default: return .gray
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text(session.pipelineStatus.gatewayStatus)
                .font(.system(.caption2))
                .foregroundColor(.secondary)

            Spacer()

            if session.pipelineStatus.isStreaming {
                Text("Live")
                    .font(.system(.caption2, design: .rounded).bold())
                    .foregroundColor(.green)
            }

            if session.pipelineStatus.tick > 0 {
                Text("#\(session.pipelineStatus.tick)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundColor(.gray)
            }
        }
    }
}
