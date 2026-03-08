package com.isinain.pipeline

import com.facebook.react.bridge.ReadableMap

/**
 * All pipeline configuration in one place.
 * Mirrors iOS PipelineConfig.swift.
 */
data class PipelineConfig(
    // Gateway
    var gatewayWsUrl: String = "wss://localhost:18789",
    var gatewayToken: String = "",
    var sessionKey: String = "agent:main:sinain",

    // Vision
    var openRouterApiKey: String = "",
    var visionModel: String = "google/gemini-2.5-flash",
    var visionTimeoutMs: Int = 15_000,

    // Pipeline
    var tickIntervalS: Double = 4.0,
    var maxStalenessMultiplier: Double = 3.0,
    var maxStaleRestarts: Int = 2,
    var staleRestartCooldownS: Double = 30.0,

    // Observation
    var observationMaxEntries: Int = 20,
    var observationMaxAgeS: Double = 300.0,

    // Scene Gate
    var sceneGate: SceneGateConfig = SceneGateConfig()
) {
    /** Max staleness before triggering a stream restart. */
    val maxStalenessS: Double get() = tickIntervalS * maxStalenessMultiplier

    companion object {
        /** Create config from ReadableMap passed over the React Native bridge. */
        fun fromReadableMap(map: ReadableMap): PipelineConfig {
            val config = PipelineConfig()
            if (map.hasKey("openRouterApiKey")) config.openRouterApiKey = map.getString("openRouterApiKey") ?: ""
            if (map.hasKey("visionModel")) config.visionModel = map.getString("visionModel") ?: config.visionModel
            if (map.hasKey("gatewayWsUrl")) config.gatewayWsUrl = map.getString("gatewayWsUrl") ?: config.gatewayWsUrl
            if (map.hasKey("gatewayToken")) config.gatewayToken = map.getString("gatewayToken") ?: ""
            if (map.hasKey("sessionKey")) config.sessionKey = map.getString("sessionKey") ?: config.sessionKey
            return config
        }
    }
}

/** Scene gate thresholds — all in one place. */
data class SceneGateConfig(
    val blurThreshold: Double = 50.0,
    val brightnessMin: Double = 20.0,
    val brightnessMax: Double = 240.0,
    val duplicateHashDist: Int = 5,
    val sceneHashDist: Int = 15,
    val textMinRegions: Int = 2,
    val textMinConfidence: Double = 0.3,
    val brightnessDelta: Double = 30.0,
    val sceneCooldownMs: Double = 2_000.0,
    val textCooldownMs: Double = 5_000.0,
    val motionCooldownMs: Double = 3_000.0,
    val ambientIntervalMs: Double = 30_000.0
)
