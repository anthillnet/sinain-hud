package com.isinain.pipeline

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.math.abs

/**
 * Analyzes JPEG frames for blur, brightness, perceptual hash, and text regions.
 *
 * Android equivalent of iOS FrameAnalyzer.swift:
 *   - Accelerate/vImage → manual pixel operations on Bitmap
 *   - Vision framework → ML Kit Text Recognition
 *   - CGContext grayscale → Bitmap + ColorMatrix desaturation
 */
class FrameAnalyzer : FrameAnalyzing {

    private val log = PipelineLogger("FrameAnalyzer")
    private val textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    override suspend fun analyze(jpegData: ByteArray): FrameAnalysis? = withContext(Dispatchers.Default) {
        val t0 = System.nanoTime()

        val bitmap = BitmapFactory.decodeByteArray(jpegData, 0, jpegData.size) ?: run {
            log.warn("failed to decode JPEG")
            return@withContext null
        }

        val width = bitmap.width
        val height = bitmap.height

        // 1. Grayscale conversion
        val grayscale = bitmapToGrayscale(bitmap)

        // 2. Blur score (Laplacian variance)
        val blurScore = computeBlurScore(grayscale, width, height)

        // 3. Brightness (mean)
        val brightnessAvg = computeBrightness(grayscale)

        // 4. Perceptual dHash
        val perceptualHash = computeDHash(bitmap)

        // 5. Text regions via ML Kit
        val textResult = detectTextRegions(bitmap)

        bitmap.recycle()

        val analysisMs = (System.nanoTime() - t0) / 1_000_000.0

        FrameAnalysis(
            blurScore = blurScore,
            brightnessAvg = brightnessAvg,
            perceptualHash = perceptualHash,
            textRegionCount = textResult.regionCount,
            textRegionConfidences = textResult.confidences,
            nativeOcrText = textResult.text,
            analysisMs = (analysisMs * 10).toLong() / 10.0
        )
    }

    // ── Grayscale conversion ──────────────────────────────────

    private fun bitmapToGrayscale(bitmap: Bitmap): IntArray {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        // Convert ARGB to grayscale using luminance formula
        val gray = IntArray(w * h)
        for (i in pixels.indices) {
            val p = pixels[i]
            val r = (p shr 16) and 0xFF
            val g = (p shr 8) and 0xFF
            val b = p and 0xFF
            // ITU-R BT.601 luminance
            gray[i] = (0.299 * r + 0.587 * g + 0.114 * b).toInt()
        }
        return gray
    }

    // ── Blur detection (Laplacian variance) ───────────────────

    /**
     * Applies 3x3 Laplacian kernel [0,1,0,1,-4,1,0,1,0] then computes variance.
     * Higher variance = sharper image.
     * Equivalent to iOS vImageConvolve_Planar8 + vDSP variance.
     */
    private fun computeBlurScore(gray: IntArray, width: Int, height: Int): Double {
        if (width < 3 || height < 3) return 0.0

        var sum = 0.0
        var sumSq = 0.0
        var count = 0

        for (y in 1 until height - 1) {
            for (x in 1 until width - 1) {
                val idx = y * width + x
                // Laplacian: center * -4 + top + bottom + left + right
                val laplacian = (
                    gray[idx - width] +        // top
                    gray[idx + width] +        // bottom
                    gray[idx - 1] +            // left
                    gray[idx + 1] +            // right
                    gray[idx] * -4             // center
                )
                val v = laplacian + 128        // bias to match iOS (unsigned output)
                sum += v
                sumSq += v.toDouble() * v
                count++
            }
        }

        if (count == 0) return 0.0
        val mean = sum / count
        val meanSq = sumSq / count
        return meanSq - mean * mean
    }

    // ── Brightness (mean of grayscale) ────────────────────────

    private fun computeBrightness(gray: IntArray): Double {
        if (gray.isEmpty()) return 0.0
        var sum = 0L
        for (v in gray) sum += v
        return sum.toDouble() / gray.size
    }

    // ── Perceptual dHash ──────────────────────────────────────

    /**
     * Downscale to 9x8 grayscale, compute horizontal gradient, 64-bit hash.
     * Identical algorithm to iOS computeDHash.
     */
    private fun computeDHash(bitmap: Bitmap): String {
        val dw = 9
        val dh = 8

        // Scale down to 9x8
        val scaled = Bitmap.createScaledBitmap(bitmap, dw, dh, true)
        val grayScaled = bitmapToGrayscale(scaled)
        if (scaled !== bitmap) scaled.recycle()

        var hash = 0L
        var bit = 0
        for (row in 0 until dh) {
            for (col in 0 until dw - 1) {
                if (grayScaled[row * dw + col] > grayScaled[row * dw + col + 1]) {
                    hash = hash or (1L shl bit)
                }
                bit++
            }
        }

        return String.format("%016x", hash)
    }

    // ── Text detection (ML Kit) ───────────────────────────────

    private data class TextResult(
        val regionCount: Int,
        val confidences: List<Double>,
        val text: String
    )

    /**
     * Uses ML Kit Text Recognition v2 — equivalent to iOS VNRecognizeTextRequest.
     * Returns recognized text blocks sorted by vertical position.
     */
    private suspend fun detectTextRegions(bitmap: Bitmap): TextResult {
        return suspendCancellableCoroutine { cont ->
            val inputImage = InputImage.fromBitmap(bitmap, 0)

            textRecognizer.process(inputImage)
                .addOnSuccessListener { visionText ->
                    val blocks = visionText.textBlocks
                    val regionCount = blocks.size

                    // ML Kit doesn't expose per-block confidence directly,
                    // but lines have confidence on Android API 26+.
                    // Use block-level heuristic: if text was recognized, confidence ≈ 0.8
                    val confidences = blocks.map { block ->
                        // Use the average line confidence if available,
                        // otherwise assume 0.8 for any recognized block
                        val lineConfs = block.lines.mapNotNull { line ->
                            line.confidence?.toDouble()
                        }
                        if (lineConfs.isNotEmpty()) lineConfs.average() else 0.8
                    }

                    // Sort blocks by vertical position (top of bounding box)
                    val sortedTexts = blocks
                        .sortedBy { it.boundingBox?.top ?: 0 }
                        .map { it.text }

                    val ocrText = sortedTexts.joinToString("\n")

                    cont.resume(TextResult(regionCount, confidences, ocrText))
                }
                .addOnFailureListener { e ->
                    log.warn("ML Kit text recognition failed: ${e.message}")
                    cont.resume(TextResult(0, emptyList(), ""))
                }
        }
    }
}
