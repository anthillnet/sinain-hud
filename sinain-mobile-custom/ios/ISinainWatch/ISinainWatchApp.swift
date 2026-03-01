import SwiftUI

@main
struct ISinainWatchApp: App {
    @StateObject private var sessionManager = WatchSessionManager.shared

    init() {
        WatchSessionManager.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(sessionManager)
        }
    }
}
