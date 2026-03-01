package com.isinain.pipeline

/**
 * Circular buffer of recent observations + markdown message builder.
 * Direct port of iOS ObservationBuilder.swift — pure string manipulation.
 */
class ObservationBuilder(
    private val maxEntries: Int = 20,
    private val maxAgeS: Double = 300.0
) : ObservationBuilding {

    private data class Entry(
        val timestamp: Double,
        val description: String,
        val ocrText: String,
        val classification: FrameClass?
    )

    private val buffer = mutableListOf<Entry>()
    override var tick: Int = 0
        private set

    private val log = PipelineLogger("ObservationBuilder")

    override fun add(description: String, ocrText: String, classification: FrameClass?) {
        tick++
        prune()
        buffer.add(Entry(
            timestamp = System.currentTimeMillis() / 1000.0,
            description = description,
            ocrText = ocrText,
            classification = classification
        ))
        if (buffer.size > maxEntries) {
            buffer.removeAt(0)
        }
    }

    private val recent: List<Entry>
        get() {
            prune()
            return buffer.toList()
        }

    override fun buildMessage(description: String, ocrText: String, classification: FrameClass): String {
        val now = System.currentTimeMillis() / 1000.0
        val recentEntries = recent
        val parts = mutableListOf<String>()

        // Header
        var header = "[sinain-wearable live context — tick #$tick]"
        if (classification == FrameClass.MOTION) {
            header += " [motion detected]"
        } else if (classification == FrameClass.AMBIENT) {
            header += " [ambient update]"
        }
        parts.add(header)
        parts.add("")

        // What I See
        parts.add("## What I See")
        parts.add(if (description.isEmpty()) "[frame — no description available]" else description)

        // Visible Text
        if (ocrText.isNotEmpty()) {
            parts.add("")
            parts.add("### Visible Text")
            parts.add("```")
            var ocrDisplay = ocrText.take(500)
            if (ocrText.length > 500) {
                ocrDisplay += "\n[...truncated]"
            }
            parts.add(ocrDisplay)
            parts.add("```")
        }

        // Recent Context — exclude the current (last) entry
        val historyEntries = if (recentEntries.size > 1) {
            recentEntries.dropLast(1).takeLast(8)
        } else {
            emptyList()
        }

        if (historyEntries.isNotEmpty()) {
            parts.add("")
            parts.add("## Recent Context")
            for (entry in historyEntries.reversed()) {
                val age = (now - entry.timestamp).toInt()
                val tag = entry.classification?.let { "[${it.value}]" } ?: ""
                if (entry.description.isNotEmpty()) {
                    var line = "- [${age}s ago] $tag ${entry.description}"
                    if (entry.ocrText.isNotEmpty()) {
                        val snippet = entry.ocrText.take(60).replace("\n", " ")
                        line += " — \"$snippet\""
                    }
                    parts.add(line)
                } else {
                    parts.add("- [${age}s ago] $tag [frame]")
                }
            }
        }

        // Instructions
        val instruction = getInstructions(description, ocrText, classification)
        parts.add("")
        parts.add("## Instructions")
        parts.add("**Display constraint:** Mobile phone screen. 2-4 concise sentences.")
        parts.add(instruction)
        parts.add("")
        parts.add("Respond naturally — this will appear on the user's mobile screen.")

        return parts.joinToString("\n")
    }

    // ── Private ───────────────────────────────────────────────

    private fun prune() {
        val cutoff = System.currentTimeMillis() / 1000.0 - maxAgeS
        while (buffer.isNotEmpty() && buffer[0].timestamp < cutoff) {
            buffer.removeAt(0)
        }
    }

    companion object {
        private const val MANDATE =
            "ALWAYS provide a substantive response. Do NOT respond with emoji, NO_REPLY, or filler."

        private val ERROR_PATTERNS = listOf(
            "error", "Error", "ERROR",
            "exception", "Exception",
            "failed", "Failed", "FAILED",
            "traceback", "Traceback",
            "fault", "panic",
            "WARN", "warning", "Warning",
            "denied", "refused",
            "timeout", "Timeout"
        )

        private val PEOPLE_KEYWORDS = listOf(
            "person", "people", "meeting", "conversation", "talking",
            "audience", "group", "face", "crowd", "presenter", "speaker"
        )

        private val SCREEN_KEYWORDS = listOf(
            "screen", "monitor", "code", "terminal", "laptop",
            "editor", "browser", "ide", "desktop", "window"
        )

        private fun hasErrorPattern(text: String): Boolean =
            ERROR_PATTERNS.any { text.contains(it) }

        fun getInstructions(
            description: String,
            ocrText: String,
            classification: FrameClass
        ): String {
            val descLower = description.lowercase()

            if (ocrText.isNotEmpty() && hasErrorPattern(ocrText)) {
                return """
                    $MANDATE
                    Identify the specific error, explain the root cause, and suggest a concrete fix.
                    If you recognize the library or framework, reference relevant docs or common solutions.
                    (2-4 sentences). Be specific — quote the error text.
                """.trimIndent()
            }

            if (ocrText.isNotEmpty()) {
                return """
                    $MANDATE
                    Provide insight, translation, or context about what the user is reading.
                    Do NOT just repeat or summarize the visible text — the user can already see it.
                    Share a relevant connection, practical tip, or deeper explanation.
                    (2-4 sentences). Be specific and actionable.
                """.trimIndent()
            }

            if (classification == FrameClass.MOTION) {
                return """
                    $MANDATE
                    Movement or activity was detected. Describe what's happening and offer relevant context.
                    If someone is exercising: form tips. If walking somewhere: navigation or local info.
                    If interacting with objects: relevant tips or observations.
                    (2-4 sentences). Be specific and actionable.
                """.trimIndent()
            }

            if (PEOPLE_KEYWORDS.any { descLower.contains(it) }) {
                return """
                    $MANDATE
                    The user appears to be in a social or meeting context.
                    Offer a situational tip: conversation starters, body language insight, meeting facilitation advice, or note key takeaways.
                    (2-4 sentences). Be helpful without being awkward.
                """.trimIndent()
            }

            if (SCREEN_KEYWORDS.any { descLower.contains(it) }) {
                return """
                    $MANDATE
                    Based on what's on screen:
                    - If there's an error: investigate and suggest a fix
                    - If the user seems stuck: offer guidance or a next step
                    - If they're reading/browsing: share a relevant insight or practical tip
                    NEVER just describe what the user is doing — they can see their own screen.
                    (2-4 sentences). Be specific and actionable.
                """.trimIndent()
            }

            return """
                $MANDATE
                If the context suggests outdoors, a store, transit, or any real-world setting: share a clever observation, fun fact, or practical tip relevant to the scene.
                If context is minimal: tell a short, clever joke (tech humor, wordplay, or observational — keep it fresh).
                NEVER respond with "standing by", "monitoring", emoji, or similar filler.
                Every response must teach something, suggest something, or connect dots the user hasn't noticed.
                (2-4 sentences).
            """.trimIndent()
        }
    }
}
