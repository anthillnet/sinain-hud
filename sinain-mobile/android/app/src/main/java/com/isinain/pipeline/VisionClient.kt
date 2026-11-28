package com.isinain.pipeline

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Vision API client — sends base64 JPEG frames to OpenRouter for scene description + OCR.
 * Port of iOS VisionClient.swift using OkHttp instead of URLSession.
 */
class VisionClient : VisionAnalyzing {

    private val log = PipelineLogger("VisionClient")

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    override suspend fun analyzeFrame(
        base64Jpeg: String,
        apiKey: String,
        model: String,
        timeoutMs: Int,
        classification: FrameClass
    ): VisionResult = withContext(Dispatchers.IO) {
        val t0 = System.nanoTime()
        val params = visionParams(classification)

        val payload = JSONObject().apply {
            put("model", model)
            put("messages", JSONArray().put(
                JSONObject().apply {
                    put("role", "user")
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", params.prompt)
                        })
                        put(JSONObject().apply {
                            put("type", "image_url")
                            put("image_url", JSONObject().apply {
                                put("url", "data:image/jpeg;base64,$base64Jpeg")
                                put("detail", params.detail)
                            })
                        })
                    })
                }
            ))
            put("max_tokens", params.maxTokens)
            put("temperature", 0)
        }

        val request = Request.Builder()
            .url(OPENROUTER_URL)
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .build()

        // Use a per-request client with the specific timeout
        val client = httpClient.newBuilder()
            .callTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .build()

        try {
            val response = client.newCall(request).execute()

            if (!response.isSuccessful) {
                val body = response.body?.string()?.take(200) ?: ""
                log.error("API error ${response.code}: $body")
                return@withContext VisionResult("", "", elapsedMs(t0))
            }

            val body = response.body?.string() ?: ""
            val json = JSONObject(body)
            val choices = json.optJSONArray("choices") ?: return@withContext VisionResult("", "", elapsedMs(t0))
            val message = choices.optJSONObject(0)?.optJSONObject("message")
                ?: return@withContext VisionResult("", "", elapsedMs(t0))
            val raw = message.optString("content", "").trim()

            val latency = elapsedMs(t0)
            val parsed = parseResponse(raw)

            if (parsed.first.isNotEmpty()) {
                log.info("${classification.value} ${raw.length} chars in ${"%.1f".format(latency / 1000.0)}s (tokens=${params.maxTokens}, via $model)")
            }

            VisionResult(parsed.first, parsed.second, latency)
        } catch (e: java.net.SocketTimeoutException) {
            log.warn("timed out after ${timeoutMs}ms")
            VisionResult("", "", elapsedMs(t0))
        } catch (e: Exception) {
            log.error("error: ${e.message}")
            VisionResult("", "", elapsedMs(t0))
        }
    }

    // ── Private ───────────────────────────────────────────────

    private data class VisionParams(
        val prompt: String,
        val detail: String,
        val maxTokens: Int
    )

    private fun visionParams(classification: FrameClass): VisionParams = when (classification) {
        FrameClass.TEXT -> VisionParams(PROMPT_TEXT_ROI, "auto", 1500)
        FrameClass.MOTION -> VisionParams(PROMPT_MOTION, "auto", 1200)
        else -> VisionParams(PROMPT_SCENE, "auto", 1200)
    }

    private fun elapsedMs(t0: Long): Int = ((System.nanoTime() - t0) / 1_000_000).toInt()

    companion object {
        private const val OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

        private const val PROMPT_SCENE =
            "Analyze this image from a wearable camera.\n\n" +
            "1. SCENE: Describe what you see. Include the setting, environment, " +
            "notable objects, people, activities, signage, screens, colors, lighting, " +
            "and anything noteworthy. Be detailed and specific.\n\n" +
            "2. TEXT: Extract any visible text exactly as it appears, preserving " +
            "line breaks and layout. If no text is visible, write: none\n" +
            "For blurry or partially obscured text, give your best reading.\n\n" +
            "Format your response exactly as:\n" +
            "SCENE: [your description]\n" +
            "TEXT: [extracted text or none]"

        private const val PROMPT_TEXT_ROI =
            "This is a cropped region from a wearable camera, focused on a text area.\n\n" +
            "1. TEXT: Extract ALL visible text exactly as it appears, preserving " +
            "line breaks, spacing, and layout. Be thorough — capture every character, " +
            "number, and symbol.\n" +
            "For blurry or partially obscured text, give your best reading.\n\n" +
            "2. SCENE: Briefly describe the context around the text (what surface, " +
            "device, sign, or document the text appears on).\n\n" +
            "Format your response exactly as:\n" +
            "SCENE: [brief context]\n" +
            "TEXT: [extracted text or none]"

        private const val PROMPT_MOTION =
            "Analyze this image from a wearable camera — movement or activity was detected.\n\n" +
            "1. SCENE: Describe the activity, movement, or change happening. " +
            "Focus on what's in motion, who's involved, and the setting.\n\n" +
            "2. TEXT: Extract any visible text exactly as it appears. If no text is visible, write: none\n" +
            "For blurry or partially obscured text, give your best reading.\n\n" +
            "Format your response exactly as:\n" +
            "SCENE: [your description]\n" +
            "TEXT: [extracted text or none]"

        /** Parse "SCENE: ... TEXT: ..." response format. */
        fun parseResponse(raw: String): Pair<String, String> {
            if (raw.isEmpty()) return Pair("", "")

            var description = ""
            var ocrText = ""

            val sceneIdx = raw.indexOf("SCENE:")
            val textIdx = raw.indexOf("TEXT:")

            if (sceneIdx != -1 && textIdx != -1 && textIdx > sceneIdx) {
                description = raw.substring(sceneIdx + 6, textIdx).trim()
                ocrText = raw.substring(textIdx + 5).trim()
            } else if (sceneIdx != -1) {
                description = raw.substring(sceneIdx + 6).trim()
            } else {
                description = raw
            }

            val lower = ocrText.lowercase()
            if (lower == "none" || lower == "none.") {
                ocrText = ""
            }

            return Pair(description, ocrText)
        }
    }
}
