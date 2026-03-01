package com.isinain.pipeline

/**
 * Content-aware frame gating — classifies frames into scene/text/motion/ambient/drop.
 *
 * Direct port of iOS SceneGate.swift. Pure logic, no platform-specific APIs.
 *
 * Classification priority chain:
 *   1. In-flight guard        → DROP
 *   2. blurScore < threshold  → DROP "blurry"
 *   3. brightness extreme     → DROP "exposure"
 *   4. First frame (no hash)  → SCENE "first frame"
 *   5. Hash hamming dist < 5  → DROP "duplicate" (or AMBIENT heartbeat)
 *   6. Hash hamming dist > 15 → SCENE "major change"
 *   7. textRegions >= 2       → TEXT
 *   8. |brightness delta| > 30→ MOTION
 *   9. 30s since last ambient → AMBIENT
 *  10. Default                → DROP
 */
class SceneGate(private val config: SceneGateConfig) : SceneGating {

    private val log = PipelineLogger("SceneGate")
    private var inFlight = false
    private var prevHash: String? = null
    private var prevBrightness: Double? = null
    private val lastSend = mutableMapOf<FrameClass, Double>()
    private var lastAmbientTime: Double = 0.0

    override fun classify(analysis: FrameAnalysis): GateResult {
        val now = System.currentTimeMillis().toDouble()

        // 1. In-flight guard
        if (inFlight) {
            return GateResult(FrameClass.DROP, "in-flight")
        }

        // 2. Blur rejection
        if (config.blurThreshold > 0 && analysis.blurScore < config.blurThreshold) {
            return GateResult(FrameClass.DROP, "blurry")
        }

        // 3. Exposure rejection
        if (analysis.brightnessAvg < config.brightnessMin || analysis.brightnessAvg > config.brightnessMax) {
            return GateResult(FrameClass.DROP, "exposure")
        }

        // 4. First frame — always send as SCENE
        val prevHashVal = prevHash
        if (prevHashVal == null) {
            accept(FrameClass.SCENE, analysis, now)
            return GateResult(FrameClass.SCENE, "first frame")
        }

        // 5-6. Perceptual hash comparison
        val dist = hammingDistance(prevHashVal, analysis.perceptualHash)

        if (dist < config.duplicateHashDist) {
            if (now - lastAmbientTime >= config.ambientIntervalMs) {
                accept(FrameClass.AMBIENT, analysis, now)
                return GateResult(FrameClass.AMBIENT, "heartbeat")
            }
            return GateResult(FrameClass.DROP, "duplicate")
        }

        if (dist > config.sceneHashDist) {
            if (!inCooldown(FrameClass.SCENE, now)) {
                accept(FrameClass.SCENE, analysis, now)
                return GateResult(FrameClass.SCENE, "major change")
            }
        }

        // 7. Text regions
        val confidentCount = analysis.textRegionConfidences.count { it > config.textMinConfidence }
        if (confidentCount >= config.textMinRegions) {
            if (!inCooldown(FrameClass.TEXT, now)) {
                accept(FrameClass.TEXT, analysis, now)
                return GateResult(FrameClass.TEXT, "$confidentCount text regions")
            }
        }

        // 8. Motion proxy (brightness delta)
        val prevBright = prevBrightness
        if (prevBright != null) {
            val delta = kotlin.math.abs(analysis.brightnessAvg - prevBright)
            if (delta > config.brightnessDelta) {
                if (!inCooldown(FrameClass.MOTION, now)) {
                    accept(FrameClass.MOTION, analysis, now)
                    return GateResult(FrameClass.MOTION, "brightness delta ${delta.toInt()}")
                }
            }
        }

        // 9. Ambient heartbeat
        if (now - lastAmbientTime >= config.ambientIntervalMs) {
            accept(FrameClass.AMBIENT, analysis, now)
            return GateResult(FrameClass.AMBIENT, "heartbeat")
        }

        // 10. Default
        return GateResult(FrameClass.DROP, "no trigger")
    }

    override fun markProcessing() { inFlight = true }
    override fun markDone() { inFlight = false }

    // ── Private ───────────────────────────────────────────────

    private fun accept(cls: FrameClass, analysis: FrameAnalysis, now: Double) {
        prevHash = analysis.perceptualHash
        prevBrightness = analysis.brightnessAvg
        lastSend[cls] = now
        if (cls == FrameClass.AMBIENT) {
            lastAmbientTime = now
        }
    }

    private fun inCooldown(cls: FrameClass, now: Double): Boolean {
        val last = lastSend[cls] ?: 0.0
        val cooldown = getCooldown(cls)
        return (now - last) < cooldown
    }

    private fun getCooldown(cls: FrameClass): Double = when (cls) {
        FrameClass.SCENE -> config.sceneCooldownMs
        FrameClass.TEXT -> config.textCooldownMs
        FrameClass.MOTION -> config.motionCooldownMs
        else -> 0.0
    }

    companion object {
        /** Hamming distance between two hex-encoded 64-bit hashes. */
        fun hammingDistance(a: String, b: String): Int {
            val ai = a.toULongOrNull(16) ?: 0UL
            val bi = b.toULongOrNull(16) ?: 0UL
            return (ai xor bi).countOneBits()
        }
    }
}
