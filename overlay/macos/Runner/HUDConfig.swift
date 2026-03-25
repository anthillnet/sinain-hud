import Cocoa

struct HUDConfig {
    // Default sizes per overlay state
    static let eyeSize: CGFloat = 48
    static let controlsBarHeight: CGFloat = 48
    static let controlsBarWidth: CGFloat = 280
    static let defaultChatWidth: CGFloat = 427
    static let defaultChatHeight: CGFloat = 293

    // Constraints
    static let minChatWidth: CGFloat = 300
    static let minChatHeight: CGFloat = 200
    static let maxChatWidth: CGFloat = 800
    static let maxChatHeight: CGFloat = 900

    static let margin: CGFloat = 16
    static let fallbackScreenRect = NSRect(x: 0, y: 0, width: 1920, height: 1080)
}
