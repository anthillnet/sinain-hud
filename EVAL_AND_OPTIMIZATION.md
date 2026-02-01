# Evaluation & Optimization Plan: SinainHUD Pipeline

## Current End-to-End Latency (worst case)

```
Speech → [10s chunk] → [2-15s transcribe] → [30s relay batch] → [30s agent tick] → [1-4s LLM]
                                                                                     ≈ 75-89s
Screen → [1-2s capture] → [5s cooldown] → [200-500ms OCR] → [30s agent tick] → [1-4s LLM]
                                                                                ≈ 37-42s
```

The system is latency-bound at three chokepoints: audio chunking, relay batching, and the agent tick interval.

---

## 1. Sense Client — Evaluation & Optimization

### Current bottlenecks

- `screencapture` subprocess: 1-1.5s per frame
- OCR via Vision framework: 200-500ms per ROI
- 5s cooldown between events
- SSIM threshold (0.92) may miss subtle but meaningful changes

### Optimization opportunities

| Technique | Latency Impact | Quality Impact | Effort |
|-----------|---------------|----------------|--------|
| Replace `screencapture` with CGDisplayStream (CoreGraphics) | -1s per frame | None | Medium |
| Adaptive SSIM threshold (lower when app changes, higher when idle) | None | Fewer missed changes | Low |
| Parallel OCR on multiple ROIs | -200ms when >1 ROI | None | Low |
| Skip image encoding for text-only events (send OCR only) | -200ms | Minor (no visual context) | Low |
| Adaptive cooldown (shorter after app switch, longer when stable) | -3s average | Fewer duplicates | Low |

### Evaluation metrics to introduce

1. **Change detection recall** — Record screen sessions, manually annotate "meaningful changes." Measure what % the SSIM gate catches vs misses. This is test-based evaluation per the framework.
2. **OCR accuracy** — Capture screenshots with known text, compare OCR output vs ground truth using character error rate (CER). Benchmark Vision vs Tesseract.
3. **Gate precision** — Track how many events the agent actually *uses* vs receives. High drop rate at agent level means sense is sending noise.
4. **Event-to-relay latency** — Instrument `ts` at capture vs `ts` at relay receipt. Track P50/P95.

---

## 2. Audio Pipeline — Evaluation & Optimization

### Current bottlenecks

- 10s chunk duration (must wait for full chunk before transcription)
- OpenRouter round-trip: 2-15s per chunk
- 30s relay batch interval (transcripts sit in bridge before reaching relay)
- VAD is energy-only (no spectral analysis), misses whispered speech

### Optimization opportunities

| Technique | Latency Impact | Quality Impact | Effort |
|-----------|---------------|----------------|--------|
| Reduce chunk to 3-5s | -5-7s per cycle | Slightly worse transcript quality (less context) | Low |
| Streaming transcription (Whisper streaming or Deepgram) | -8-12s (real-time partials) | Comparable or better | Medium |
| Reduce relay batch to 5-10s for audio | -20-25s | None | Low |
| Silero VAD (neural, replaces RMS energy) | None | Better silence detection, fewer wasted API calls | Medium |
| Overlap chunks (e.g., 5s chunks with 2s overlap) | +2s redundancy | Better word boundary handling | Low |
| Speculative transcription (start on 3s, refine on 10s) | -7s for first result | Partial → full refinement | Medium |

### Evaluation metrics to introduce

1. **Word Error Rate (WER)** — Record known audio samples (meeting recordings, lectures with transcripts). Compare pipeline output to ground truth. Standard ASR benchmark.
2. **VAD recall/precision** — Annotate audio for speech vs silence segments. Measure how many speech segments VAD passes through (recall) vs how many silence segments it incorrectly passes (1-precision).
3. **Transcription latency** — Instrument `chunk.ts` vs `transcript.ts`. Track P50/P95 per backend.
4. **Cost per audio-minute** — Track tokens consumed per minute of audio. Compare backends (OpenRouter Gemini vs Whisper vs Deepgram).
5. **LLM-as-Judge for transcript quality** — For subjective quality (readability, coherence), use a judge prompt: "Rate this transcript for accuracy, completeness, and readability on a 1-4 scale given the audio context."

---

## 3. Agent Loop — Evaluation & Optimization

### Current bottlenecks

- 30s tick interval (the dominant delay)
- Context window mixes 120s of data equally (no recency weighting)
- Idle suppression can miss rapid activity bursts that start mid-interval
- Single LLM call (no retry, no fallback)
- 200 max tokens can truncate rich digests

### Optimization opportunities

| Technique | Latency Impact | Quality Impact | Effort |
|-----------|---------------|----------------|--------|
| Event-driven ticks (trigger on new sense/audio event, debounced 3-5s) | -25s average | Much fresher context | Medium |
| Recency weighting in context (newest events first, truncate oldest) | None | Better relevance | Low |
| Increase max_tokens to 300-400 | +0.5s | Richer digests | Trivial |
| Two-tier model: fast model for HUD, better model for digest | -1-2s for HUD | Better digest quality | Medium |
| Cache-aware prompting (send only delta from last tick) | -0.5s (fewer tokens) | Requires careful diffing | Medium |
| Structured output (JSON mode if model supports it) | None | Fewer parse failures | Low |
| Fallback model chain (Flash Lite → Flash → Haiku) | +2-5s on failure | Higher availability | Low |

### Evaluation metrics to introduce

1. **LLM-as-Judge for HUD quality** — Build a dataset of (context, expected_hud) pairs from real sessions. Judge prompt:
   ```
   Given this screen/audio context, rate the HUD line on:
   - Accuracy (does it describe what the user is doing?) 1-4
   - Conciseness (is it within 15 words, no filler?) 1-4
   - Specificity (does it mention app/file names?) 1-4
   ```

2. **LLM-as-Judge for digest quality** — Same dataset, different rubric:
   ```
   Rate the digest on:
   - Completeness (does it capture all visible context?) 1-4
   - Factual accuracy (does it match OCR/audio content?) 1-4
   - Actionability (would an AI assistant understand the situation?) 1-4
   - Objectivity (does it describe, not suggest?) 1-4
   ```

3. **Context freshness** — Measure age of newest event in context window at time of LLM call. Target: <5s for the most recent event.

4. **JSON parse success rate** — Track how often the agent response parses cleanly vs falls back to the plain-text hud path.

5. **HUD change rate** — Track consecutive identical HUD lines. Too many = agent is stale. Too few = agent is noisy.

6. **End-to-end latency** — From screen change or speech to HUD update. This is the metric users actually feel.

---

## Highest-Impact Changes (Ranked)

1. **Event-driven agent ticks** (debounced 3-5s after new event) — eliminates the 30s fixed interval, the single largest latency contributor
2. **Reduce audio chunk to 5s** — halves the audio capture latency with minimal quality loss
3. **Reduce relay batch interval for audio to 5-10s** — another 20-25s saved
4. **Adaptive sense cooldown** (2s after app switch, 5s otherwise) — faster response to context changes
5. **LLM-as-Judge evaluation harness** — enables data-driven iteration on all the above

These five changes alone would bring worst-case end-to-end latency from ~80s down to ~15-20s.

---

## Evaluation Maturity Roadmap

Per the agentic evaluation framework (see `agentic-evaluation-intro.md`):

**Current state: L1 (Ad-hoc)** — No systematic evaluation, manual testing only.

### L1 → L2: Foundation

- [ ] Define success criteria for each subsystem (latency targets, quality thresholds)
- [ ] Build initial benchmark datasets:
  - 20+ annotated screen recordings for sense evaluation
  - 10+ audio samples with ground-truth transcripts for WER
  - 50+ (context, expected_output) pairs for agent evaluation
- [ ] Instrument all three pipelines with timestamp tracing

### L2 → L3: Automation

- [ ] Automated eval on commit (run benchmarks in CI)
- [ ] LLM-as-Judge scoring integrated into test suite
- [ ] Dashboard showing latency P50/P95 and quality scores over time

### L3 → L4: Observability

- [ ] Full tracing (Langfuse or equivalent) for agent loop LLM calls
- [ ] Statistical significance testing when comparing configurations
- [ ] Cost tracking per subsystem per hour
