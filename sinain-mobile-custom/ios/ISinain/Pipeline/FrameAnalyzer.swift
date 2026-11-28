import Foundation
import UIKit
import Accelerate
import Vision

/// Analyzes JPEG frames for blur, brightness, perceptual hash, and text regions.
/// Runs entirely on a dedicated background queue — never blocks the main thread.
final class FrameAnalyzer: FrameAnalyzing {

    private let log = PipelineLogger(subsystem: "FrameAnalyzer")
    private let analysisQueue = DispatchQueue(label: "com.isinain.analysis", qos: .userInitiated)

    func analyze(_ jpegData: Data) async -> FrameAnalysis? {
        await withCheckedContinuation { continuation in
            analysisQueue.async {
                let t0 = CFAbsoluteTimeGetCurrent()

                guard let uiImage = UIImage(data: jpegData),
                      let cgImage = uiImage.cgImage else {
                    continuation.resume(returning: nil)
                    return
                }

                let width = cgImage.width
                let height = cgImage.height

                // 1. Grayscale conversion
                let grayscale = Self.cgImageToGrayscale(cgImage)

                // 2. Blur score (Laplacian variance)
                let blurScore = Self.computeBlurScore(grayscale, width: width, height: height)

                // 3. Brightness (mean)
                let brightnessAvg = Self.computeBrightness(grayscale)

                // 4. Perceptual dHash
                let perceptualHash = Self.computeDHash(cgImage)

                // 5. Text regions via Vision framework (async continuation, NOT semaphore)
                Self.detectTextRegions(cgImage: cgImage) { regions in
                    let analysisMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0

                    let textRegionCount = regions.count
                    let textRegionConfidences = regions.map { $0.confidence }
                    let sortedTexts = regions
                        .sorted { $0.y < $1.y }
                        .map { $0.text }
                        .filter { !$0.isEmpty }
                    let nativeOcrText = sortedTexts.joined(separator: "\n")

                    let result = FrameAnalysis(
                        blurScore: blurScore,
                        brightnessAvg: brightnessAvg,
                        perceptualHash: perceptualHash,
                        textRegionCount: textRegionCount,
                        textRegionConfidences: textRegionConfidences,
                        nativeOcrText: nativeOcrText,
                        analysisMs: round(analysisMs * 10) / 10
                    )
                    continuation.resume(returning: result)
                }
            }
        }
    }

    // MARK: - Analysis Helpers

    /// Convert CGImage to grayscale pixel buffer.
    private static func cgImageToGrayscale(_ image: CGImage) -> [UInt8] {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height)

        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return pixels }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pixels
    }

    /// Blur score via Laplacian kernel variance (Accelerate framework).
    private static func computeBlurScore(_ grayscale: [UInt8], width: Int, height: Int) -> Double {
        let kernel: [Int16] = [0, 1, 0, 1, -4, 1, 0, 1, 0]

        var src = vImage_Buffer(
            data: UnsafeMutablePointer(mutating: grayscale),
            height: vImagePixelCount(height),
            width: vImagePixelCount(width),
            rowBytes: width
        )

        var destPixels = [UInt8](repeating: 0, count: width * height)
        var dest = vImage_Buffer(
            data: &destPixels,
            height: vImagePixelCount(height),
            width: vImagePixelCount(width),
            rowBytes: width
        )

        kernel.withUnsafeBufferPointer { kernelPtr in
            vImageConvolve_Planar8(
                &src, &dest, nil,
                0, 0,
                kernelPtr.baseAddress!, 3, 3,
                0,
                128,
                vImage_Flags(kvImageEdgeExtend)
            )
        }

        var floats = [Float](repeating: 0, count: width * height)
        vDSP.convertElements(of: destPixels, to: &floats)

        var mean: Float = 0
        var meanSq: Float = 0
        vDSP_meanv(floats, 1, &mean, vDSP_Length(floats.count))

        var squared = [Float](repeating: 0, count: floats.count)
        vDSP_vsq(floats, 1, &squared, 1, vDSP_Length(floats.count))
        vDSP_meanv(squared, 1, &meanSq, vDSP_Length(floats.count))

        return Double(meanSq - mean * mean)
    }

    /// Mean brightness of grayscale pixels.
    private static func computeBrightness(_ grayscale: [UInt8]) -> Double {
        var floats = [Float](repeating: 0, count: grayscale.count)
        vDSP.convertElements(of: grayscale, to: &floats)
        var mean: Float = 0
        vDSP_meanv(floats, 1, &mean, vDSP_Length(floats.count))
        return Double(mean)
    }

    /// Perceptual dHash: downscale to 9x8, compute horizontal gradient, 64-bit hash.
    private static func computeDHash(_ image: CGImage) -> String {
        let dw = 9, dh = 8
        var pixels = [UInt8](repeating: 0, count: dw * dh)

        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let ctx = CGContext(
            data: &pixels,
            width: dw,
            height: dh,
            bitsPerComponent: 8,
            bytesPerRow: dw,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return "0000000000000000" }

        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: dw, height: dh))

        var hash: UInt64 = 0
        var bit = 0
        for row in 0..<dh {
            for col in 0..<(dw - 1) {
                if pixels[row * dw + col] > pixels[row * dw + col + 1] {
                    hash |= (1 << bit)
                }
                bit += 1
            }
        }

        return String(format: "%016llx", hash)
    }

    /// Text region detection via Vision framework (.accurate recognition level).
    /// Uses a completion handler — NOT a semaphore.
    private static func detectTextRegions(
        cgImage: CGImage,
        completion: @escaping ([(x: Double, y: Double, width: Double, height: Double, confidence: Double, text: String)]) -> Void
    ) {
        let request = VNRecognizeTextRequest { request, error in
            guard error == nil,
                  let observations = request.results as? [VNRecognizedTextObservation] else {
                completion([])
                return
            }

            let regions = observations.map { obs in
                let box = obs.boundingBox
                let text = obs.topCandidates(1).first?.string ?? ""
                return (
                    x: Double(box.origin.x),
                    y: Double(1.0 - box.origin.y - box.size.height),
                    width: Double(box.size.width),
                    height: Double(box.size.height),
                    confidence: Double(obs.confidence),
                    text: text
                )
            }
            completion(regions)
        }

        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            completion([])
        }
    }
}
