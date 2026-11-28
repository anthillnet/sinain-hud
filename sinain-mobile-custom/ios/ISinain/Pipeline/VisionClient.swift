import Foundation

/// Vision API client — sends base64 JPEG frames to OpenRouter for scene description + OCR.
/// Uses a dedicated URLSession instance (not .shared).
final class VisionClient: VisionAnalyzing {

    private let log = PipelineLogger(subsystem: "VisionClient")
    private let urlSession: URLSession
    private static let openRouterURL = "https://openrouter.ai/api/v1/chat/completions"

    // MARK: - Classification-specific prompts

    private static let promptScene =
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

    private static let promptTextROI =
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

    private static let promptMotion =
        "Analyze this image from a wearable camera — movement or activity was detected.\n\n" +
        "1. SCENE: Describe the activity, movement, or change happening. " +
        "Focus on what's in motion, who's involved, and the setting.\n\n" +
        "2. TEXT: Extract any visible text exactly as it appears. If no text is visible, write: none\n" +
        "For blurry or partially obscured text, give your best reading.\n\n" +
        "Format your response exactly as:\n" +
        "SCENE: [your description]\n" +
        "TEXT: [extracted text or none]"

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        urlSession = URLSession(configuration: config)
    }

    func analyzeFrame(
        base64Jpeg: String,
        apiKey: String,
        model: String,
        timeoutMs: Int = 15_000,
        classification: FrameClass = .scene
    ) async -> VisionResult {
        let t0 = CFAbsoluteTimeGetCurrent()
        let params = Self.visionParams(for: classification)

        let payload: [String: Any] = [
            "model": model,
            "messages": [
                [
                    "role": "user",
                    "content": [
                        ["type": "text", "text": params.prompt],
                        [
                            "type": "image_url",
                            "image_url": [
                                "url": "data:image/jpeg;base64,\(base64Jpeg)",
                                "detail": params.detail,
                            ],
                        ],
                    ],
                ] as [String: Any],
            ],
            "max_tokens": params.maxTokens,
            "temperature": 0,
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let url = URL(string: Self.openRouterURL) else {
            return VisionResult(description: "", ocrText: "", latencyMs: elapsed(t0))
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        request.timeoutInterval = TimeInterval(timeoutMs) / 1000.0

        do {
            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                let body = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
                log.error("API error \(statusCode): \(body)")
                return VisionResult(description: "", ocrText: "", latencyMs: elapsed(t0))
            }

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choices = json["choices"] as? [[String: Any]],
                  let message = choices.first?["message"] as? [String: Any],
                  let raw = message["content"] as? String else {
                return VisionResult(description: "", ocrText: "", latencyMs: elapsed(t0))
            }

            let latency = elapsed(t0)
            let parsed = Self.parseResponse(raw.trimmingCharacters(in: .whitespacesAndNewlines))

            if !parsed.description.isEmpty {
                log.info("\(classification.rawValue) \(raw.count) chars in \(String(format: "%.1f", Double(latency) / 1000))s (tokens=\(params.maxTokens), via \(model))")
            }

            return VisionResult(description: parsed.description, ocrText: parsed.ocrText, latencyMs: latency)
        } catch {
            if (error as NSError).code == NSURLErrorTimedOut {
                log.warn("timed out after \(timeoutMs)ms")
            } else {
                log.error("error: \(error.localizedDescription)")
            }
            return VisionResult(description: "", ocrText: "", latencyMs: elapsed(t0))
        }
    }

    // MARK: - Private

    private struct VisionParams {
        let prompt: String
        let detail: String
        let maxTokens: Int
    }

    private static func visionParams(for classification: FrameClass) -> VisionParams {
        if classification == .text {
            return VisionParams(prompt: promptTextROI, detail: "auto", maxTokens: 1500)
        }
        if classification == .motion {
            return VisionParams(prompt: promptMotion, detail: "auto", maxTokens: 1200)
        }
        return VisionParams(prompt: promptScene, detail: "auto", maxTokens: 1200)
    }

    private static func parseResponse(_ raw: String) -> (description: String, ocrText: String) {
        guard !raw.isEmpty else { return ("", "") }

        var description = ""
        var ocrText = ""

        if let sceneRange = raw.range(of: "SCENE:"),
           let textRange = raw.range(of: "TEXT:"),
           textRange.lowerBound > sceneRange.upperBound {
            description = String(raw[sceneRange.upperBound..<textRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            ocrText = String(raw[textRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let sceneRange = raw.range(of: "SCENE:") {
            description = String(raw[sceneRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            description = raw
        }

        let lower = ocrText.lowercased()
        if lower == "none" || lower == "none." {
            ocrText = ""
        }

        return (description, ocrText)
    }

    private func elapsed(_ t0: CFAbsoluteTime) -> Int {
        Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)
    }
}
