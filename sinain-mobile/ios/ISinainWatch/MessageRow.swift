import SwiftUI

struct MessageRow: View {
    let message: WatchMessage

    @State private var dotOpacity: Double = 1.0

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if message.isStreaming {
                Circle()
                    .fill(Color.blue)
                    .frame(width: 6, height: 6)
                    .padding(.top, 5)
                    .opacity(dotOpacity)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                            dotOpacity = 0.3
                        }
                    }
            }

            VStack(alignment: .leading, spacing: 2) {
                if !message.displayTime.isEmpty {
                    Text(message.displayTime)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundColor(.gray)
                }
                Text(message.text)
                    .font(.system(.body))
                    .foregroundColor(.primary)
                    .lineLimit(nil)
            }
        }
    }
}
