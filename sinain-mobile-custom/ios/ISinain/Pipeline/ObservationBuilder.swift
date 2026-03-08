import Foundation

/// Observation entry stored in the circular buffer.
struct ObservationEntry {
    let timestamp: TimeInterval
    let description: String
    let ocrText: String
    let classification: FrameClass?
}

/// Circular buffer of recent observations + markdown message builder.
final class ObservationBuilder: ObservationBuilding {

    private var buffer: [ObservationEntry] = []
    private let maxEntries: Int
    private let maxAgeS: TimeInterval
    private(set) var tick: Int = 0
    private let log = PipelineLogger(subsystem: "ObservationBuilder")

    init(maxEntries: Int = 20, maxAgeS: TimeInterval = 300) {
        self.maxEntries = maxEntries
        self.maxAgeS = maxAgeS
    }

    func add(description: String, ocrText: String, classification: FrameClass? = nil) {
        tick += 1
        prune()
        buffer.append(ObservationEntry(
            timestamp: Date().timeIntervalSince1970,
            description: description,
            ocrText: ocrText,
            classification: classification
        ))
        if buffer.count > maxEntries {
            buffer.removeFirst()
        }
    }

    var recent: [ObservationEntry] {
        prune()
        return buffer
    }

    func buildMessage(
        description: String,
        ocrText: String,
        classification: FrameClass = .scene
    ) -> String {
        let now = Date().timeIntervalSince1970
        let recentEntries = recent
        var parts: [String] = []

        // Header
        var header = "[sinain-wearable live context — tick #\(tick)]"
        if classification == .motion {
            header += " [motion detected]"
        } else if classification == .ambient {
            header += " [ambient update]"
        }
        parts.append(header)
        parts.append("")

        // What I See
        parts.append("## What I See")
        parts.append(description.isEmpty ? "[frame — no description available]" : description)

        // Visible Text
        if !ocrText.isEmpty {
            parts.append("")
            parts.append("### Visible Text")
            parts.append("```")
            var ocrDisplay = String(ocrText.prefix(500))
            if ocrText.count > 500 {
                ocrDisplay += "\n[...truncated]"
            }
            parts.append(ocrDisplay)
            parts.append("```")
        }

        // Recent Context — exclude the current (last) entry
        let historyEntries: [ObservationEntry]
        if recentEntries.count > 1 {
            let withoutLast = Array(recentEntries.dropLast())
            historyEntries = Array(withoutLast.suffix(8))
        } else {
            historyEntries = []
        }

        if !historyEntries.isEmpty {
            parts.append("")
            parts.append("## Recent Context")
            for entry in historyEntries.reversed() {
                let age = Int(now - entry.timestamp)
                let tag = entry.classification.map { "[\($0.rawValue)]" } ?? ""
                if !entry.description.isEmpty {
                    var line = "- [\(age)s ago] \(tag) \(entry.description)"
                    if !entry.ocrText.isEmpty {
                        let snippet = String(entry.ocrText.prefix(60)).replacingOccurrences(of: "\n", with: " ")
                        line += " — \"\(snippet)\""
                    }
                    parts.append(line)
                } else {
                    parts.append("- [\(age)s ago] \(tag) [frame]")
                }
            }
        }

        // Instructions
        let instruction = Self.getInstructions(
            description: description,
            ocrText: ocrText,
            classification: classification
        )
        parts.append("")
        parts.append("## Instructions")
        parts.append("**Display constraint:** Mobile phone screen. 2-4 concise sentences.")
        parts.append(instruction)
        parts.append("")
        parts.append("Respond naturally — this will appear on the user's mobile screen.")

        return parts.joined(separator: "\n")
    }

    // MARK: - Private

    private func prune() {
        let cutoff = Date().timeIntervalSince1970 - maxAgeS
        while !buffer.isEmpty && buffer[0].timestamp < cutoff {
            buffer.removeFirst()
        }
    }

    // MARK: - Instructions (classification-aware)

    private static let mandate =
        "ALWAYS provide a substantive response. Do NOT respond with emoji, NO_REPLY, or filler."

    private static let errorPatterns = [
        "error", "Error", "ERROR",
        "exception", "Exception",
        "failed", "Failed", "FAILED",
        "traceback", "Traceback",
        "fault", "panic",
        "WARN", "warning", "Warning",
        "denied", "refused",
        "timeout", "Timeout",
    ]

    private static let peopleKeywords = [
        "person", "people", "meeting", "conversation", "talking",
        "audience", "group", "face", "crowd", "presenter", "speaker",
    ]

    private static let screenKeywords = [
        "screen", "monitor", "code", "terminal", "laptop",
        "editor", "browser", "ide", "desktop", "window",
    ]

    private static func hasErrorPattern(_ text: String) -> Bool {
        errorPatterns.contains { text.contains($0) }
    }

    static func getInstructions(
        description: String,
        ocrText: String,
        classification: FrameClass
    ) -> String {
        let descLower = description.lowercased()

        if !ocrText.isEmpty && hasErrorPattern(ocrText) {
            return """
            \(mandate)
            Identify the specific error, explain the root cause, and suggest a concrete fix.
            If you recognize the library or framework, reference relevant docs or common solutions.
            (2-4 sentences). Be specific — quote the error text.
            """
        }

        if !ocrText.isEmpty {
            return """
            \(mandate)
            Provide insight, translation, or context about what the user is reading.
            Do NOT just repeat or summarize the visible text — the user can already see it.
            Share a relevant connection, practical tip, or deeper explanation.
            (2-4 sentences). Be specific and actionable.
            """
        }

        if classification == .motion {
            return """
            \(mandate)
            Movement or activity was detected. Describe what's happening and offer relevant context.
            If someone is exercising: form tips. If walking somewhere: navigation or local info.
            If interacting with objects: relevant tips or observations.
            (2-4 sentences). Be specific and actionable.
            """
        }

        if peopleKeywords.contains(where: { descLower.contains($0) }) {
            return """
            \(mandate)
            The user appears to be in a social or meeting context.
            Offer a situational tip: conversation starters, body language insight, meeting facilitation advice, or note key takeaways.
            (2-4 sentences). Be helpful without being awkward.
            """
        }

        if screenKeywords.contains(where: { descLower.contains($0) }) {
            return """
            \(mandate)
            Based on what's on screen:
            - If there's an error: investigate and suggest a fix
            - If the user seems stuck: offer guidance or a next step
            - If they're reading/browsing: share a relevant insight or practical tip
            NEVER just describe what the user is doing — they can see their own screen.
            (2-4 sentences). Be specific and actionable.
            """
        }

        return """
        \(mandate)
        If the context suggests outdoors, a store, transit, or any real-world setting: share a clever observation, fun fact, or practical tip relevant to the scene.
        If context is minimal: tell a short, clever joke (tech humor, wordplay, or observational — keep it fresh).
        NEVER respond with "standing by", "monitoring", emoji, or similar filler.
        Every response must teach something, suggest something, or connect dots the user hasn't noticed.
        (2-4 sentences).
        """
    }
}
