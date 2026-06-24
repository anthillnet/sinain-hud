import type { ContextWindow, RawRegion, RegionSlmConfig } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { buildContextWindow } from "./context-window.js";
import { buildLineList, resolveLineRegions, placeholderFor } from "./region-lines.js";
import { log, debug, error } from "../log.js";

const TAG = "region-slm";
const MAX_REGIONS = 2;  // quality over quantity — better to surface fewer, real ones

/**
 * Prompt for the fast local lane. It picks WHICH on-screen lines are worth help
 * AND writes the eye's real issue/tip — a 3B handles this focused schema cleanly
 * (unlike the heavy combined analyzer prompt, which drops the regions field), so
 * the eye is useful the instant it's detected with no second-lane upgrade.
 * Tight schema; `format: json` constrains it.
 */
const SLM_SYSTEM_PROMPT = `You pick the on-screen line(s) at the CENTER of what the user is doing, so an assistant can offer to help. Return JSON only.

Input: numbered screen lines, "[L<id>] text".

The user is almost always working on something — a slide/doc/email being written,
code, an article or topic being read, a form, a chat, an error. Pick the line
that best represents that focus. Picking something is expected on most screens.

Skip only pure chrome (menu bars, toolbars, tab strips, status bars) and blank
screens. Don't pick navigation or decoration.

For each, write a SHORT, CLEAN description in your OWN words (don't quote raw OCR):
{"line": <integer id>, "issue": "≤8 words: what they're doing / what you'd help with", "tip": "the concrete thing you'd do to advance their work", "action": "fix"|"explain"|"research"}
Max 2 — the main thing(s) in focus. Output JSON only — no prose.

Example input:
[L2] Slide 3: Why Sinain — the ambient intelligence layer
[L7] File  Edit  View  Insert  Format
Example output (L7 is chrome → skip):
{"regions":[{"line":2,"issue":"Drafting the Sinain intro slide","tip":"Sharpen the headline into a one-line value prop","action":"explain"}]}`;

export interface RegionDetectorDeps {
  feedBuffer: FeedBuffer;
  senseBuffer: SenseBuffer;
  config: RegionSlmConfig;
  maxAgeMs: number;
  /** True only when eyes are globally on (overlay toggle) AND this lane owns
   *  detection — checked before every run so the toggle stays authoritative. */
  isEnabled: () => boolean;
  /** Same sink the cloud analyzer feeds — RegionTracker.update + broadcast. */
  onRegions: (regions: RawRegion[] | undefined, ctx: ContextWindow) => void;
}

/**
 * Tier-0 region detector: a local SLM (Ollama) that detects actionable screen
 * regions on a short, screen-change-driven cadence — decoupled from the cloud
 * analyzer's hud/digest call and its multi-second debounce. Produces eyes at
 * near-frame rate with no network. Abort-on-newer drops a superseded in-flight
 * generation so it can never paint stale eyes.
 */
export class RegionDetector {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;
  private running = false;
  private lastLatencyMs = 0;
  private runs = 0;
  /** Set true once the local model is gone AND no cloud fallback is configured.
   *  Disables the lane so we don't spam a failing call every 500ms — the cloud
   *  analyzer still emits regions, so eyes keep working without the local model. */
  private modelMissing = false;
  /** Set true once we've switched this lane to the cloud model (local Ollama
   *  absent but a cloud key is configured) — keeps the FAST tier-0 lane alive in
   *  cloud mode with no local models. */
  private useCloud = false;

  constructor(private readonly deps: RegionDetectorDeps) {}

  /** Call on every screen change (sense event). Coalesces a burst into one run.
   *  `urgent` (app switch / big viewport change) skips the debounce so the new
   *  screen's regions detect the instant its OCR lands, not ~500ms later. */
  onContextChange(urgent = false): void {
    if (!this.deps.isEnabled() || this.modelMissing) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (urgent) {
      this.debounceTimer = null;
      this.detect().catch(err => error(TAG, "detect error:", err?.message ?? err));
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.detect().catch(err => error(TAG, "detect error:", err?.message ?? err));
    }, this.deps.config.debounceMs);
  }

  stop(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.inflight?.abort();
    this.inflight = null;
  }

  private async detect(): Promise<void> {
    if (!this.deps.isEnabled()) return;

    // Abort-on-newer: a still-running generation is now superseded by fresher
    // screen content — drop it so it can't paint stale eyes, and start fresh.
    if (this.running) this.inflight?.abort();

    // Lean context — regions are screen-anchored; fewer events = faster SLM.
    const ctx = buildContextWindow(
      this.deps.feedBuffer, this.deps.senseBuffer, "lean", this.deps.maxAgeMs,
    );
    // Numbered line list the model chooses from (current app's freshest frames).
    const { prompt: linesPrompt, lines } = buildLineList(ctx);
    if (lines.length === 0) return;

    const userPrompt = `Active app: ${ctx.currentApp || "?"}\nScreen lines:\n${linesPrompt}`;
    const controller = new AbortController();
    this.inflight = controller;
    const timeout = setTimeout(() => controller.abort(), this.deps.config.timeoutMs);
    this.running = true;
    const start = Date.now();

    try {
      const content = await this.callModel(userPrompt, controller.signal);
      const latencyMs = Date.now() - start;
      this.lastLatencyMs = latencyMs;
      this.runs++;

      let parsed: any;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* */ } } }

      // Normalize output shape: the richer issue/tip schema makes a 3B sometimes
      // drop the {"regions":[...]} wrapper and return a bare object or array.
      // Accept all three so a well-formed region isn't discarded on a wrapper miss.
      const rawRegions = Array.isArray(parsed?.regions) ? parsed.regions
        : Array.isArray(parsed) ? parsed
        : (parsed && parsed.line !== undefined) ? [parsed]
        : undefined;

      // Quality eyes: the line-id gives the exact anchor; the SLM now writes its
      // OWN real issue/tip (it's reliable in this focused prompt — the heavier
      // combined analyzer prompt is what dropped regions on a 3B). The templated
      // placeholder is kept only as a fallback for when the model omits prose.
      const regions = resolveLineRegions(rawRegions, lines, {
        maxRegions: MAX_REGIONS,
        placeholder: (l) => placeholderFor(l.app, l.text),
      });

      // A newer run aborted us mid-flight (controller swapped) — discard.
      if (this.inflight !== controller) {
        debug(TAG, `superseded run discarded (${latencyMs}ms)`);
        return;
      }
      if (!this.deps.isEnabled()) return;

      const activeModel = this.useCloud ? `${this.deps.config.cloudModel} (cloud)` : this.deps.config.model;
      log(TAG, `detect #${this.runs} ${latencyMs}ms model=${activeModel} ${lines.length} lines → ${regions?.length ?? 0} region(s)${regions?.length ? ": " + regions.map(r => `"${r.issue.slice(0, 36)}"`).join("; ") : ""}`);
      // Always call (even with undefined) so RegionTracker expiry advances.
      this.deps.onRegions(regions, ctx);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        debug(TAG, "generation aborted (superseded or timed out)");
      } else {
        const m = String(err?.message ?? err);
        // Local Ollama gone — model not pulled (404) or daemon down (conn refused).
        // Prefer switching the FAST lane to the cloud model (same focused prompt)
        // so tier-0 eyes keep working in cloud mode with no local models. Only
        // disable (and let the analyzer cover regions) if there's no cloud key.
        const localGone = !this.useCloud &&
          ((/\b404\b/.test(m) && /not found/i.test(m)) || /fetch failed|econnrefused|connection refused/i.test(m));
        if (localGone && this.deps.config.cloudApiKey) {
          this.useCloud = true;
          log(TAG, `local region model unavailable — switching region detection to cloud (${this.deps.config.cloudModel})`);
        } else if (localGone) {
          this.modelMissing = true;
          this.stop();
          error(TAG, `region model "${this.deps.config.model}" unavailable and no cloud key — local ROI detection disabled (regions fall back to the analyzer). Pull it with:  ollama pull ${this.deps.config.model}`);
        } else {
          error(TAG, `region call failed: ${m}`);
        }
      }
    } finally {
      clearTimeout(timeout);
      this.running = false;
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /** Run the focused region prompt on the active provider, returning the raw
   *  JSON content string. Local Ollama (/api/chat) by default; OpenRouter
   *  (OpenAI-shaped) once this.useCloud has flipped (local model absent). */
  private async callModel(userPrompt: string, signal: AbortSignal): Promise<string> {
    const cfg = this.deps.config;
    const messages = [
      { role: "system", content: SLM_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    if (this.useCloud) {
      const response = await fetch(cfg.cloudEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.cloudApiKey}` },
        body: JSON.stringify({
          model: cfg.cloudModel, messages, temperature: 0.2,
          max_tokens: cfg.maxTokens, response_format: { type: "json_object" },
        }),
        signal,
      });
      if (!response.ok) throw new Error(`openrouter ${response.status}: ${await response.text()}`);
      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content?.trim() || "";
    }
    const response = await fetch(`${cfg.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model, messages, stream: false,
        format: "json", // Ollama structured output — keeps small models valid
        options: { num_predict: cfg.maxTokens, temperature: 0.2 },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text()}`);
    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content?.trim() || "";
  }

  stats(): { runs: number; lastLatencyMs: number } {
    return { runs: this.runs, lastLatencyMs: this.lastLatencyMs };
  }
}
