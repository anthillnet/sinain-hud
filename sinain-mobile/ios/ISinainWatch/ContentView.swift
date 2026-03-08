import SwiftUI

struct ContentView: View {
    @EnvironmentObject var session: WatchSessionManager
    @State private var now = Date()

    private let refreshTimer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    private var updatedAgoText: String? {
        guard let last = session.lastUpdated else { return nil }
        let seconds = Int(now.timeIntervalSince(last))
        if seconds < 5 { return "Updated just now" }
        if seconds < 60 { return "Updated \(seconds)s ago" }
        let minutes = seconds / 60
        return "Updated \(minutes)m ago"
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                StatusHeaderView()
                    .padding(.horizontal, 4)
                    .padding(.bottom, 2)

                if session.isBackgroundMode {
                    HStack(spacing: 4) {
                        Image(systemName: "moon.fill")
                            .font(.system(size: 9))
                            .foregroundColor(.purple)
                        Text("Background mode")
                            .font(.system(.caption2))
                            .foregroundColor(.purple)
                        if let ago = updatedAgoText {
                            Text("·")
                                .foregroundColor(.gray)
                            Text(ago)
                                .font(.system(.caption2))
                                .foregroundColor(.gray)
                        }
                    }
                    .padding(.bottom, 4)
                }

                if session.messages.isEmpty {
                    Spacer()
                    VStack(spacing: 8) {
                        Text("No responses yet")
                            .font(.headline)
                            .foregroundColor(.secondary)
                        Text("Open ISinain on iPhone")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    Spacer()
                } else {
                    List(session.messages) { message in
                        MessageRow(message: message)
                            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("ISinain")
            .navigationBarTitleDisplayMode(.inline)
            .onReceive(refreshTimer) { _ in
                now = Date()
            }
        }
    }
}
