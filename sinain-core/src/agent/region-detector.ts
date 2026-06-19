import type { ContextWindow, RawRegion, RegionSlmConfig } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { buildContextWindow } from "./context-window.js";
import { buildLineList, resolveLineRegions, placeholderFor } from "./region-lines.js";
import { log, debug, error } from "../log.js";

const TAG = "region-slm";
const MAX_REGIONS = 2;  // quality over quantity — better to surface fewer, real ones

/**
 * Prompt for the fast local lane. It only has to pick WHICH on-screen lines are
 * worth help (relevance) — the eye's label is a templated placeholder, and the
 * main analyzer lane supplies the real description later, so the model's own
 * prose is intentionally ignored. Tight schema; `format: json` constrains it.
 */
const SLM_SYSTEM_PROMPT = `You flag ONLY high-value lines on a user's screen where an assistant could do real, concrete work the user would want. Return JSON only.

Input: numbered screen lines, "[L<id>] text".

Most screens need NOTHING — passive reading, browsing, social feeds, chat
scrollback, menus. {"regions":[]} is the correct, common answer. When unsure, none.

FLAG only clear, high-value things:
- an error / failure / stack trace / warning
- a question or problem the user is visibly trying to solve
- a form / task / command they are actively working through
- code or config with a concrete bug or TODO

Do NOT flag passive content (feeds, articles, posts) or quality nitpicks
(grammar, wording, timestamp/format). Those are noise.

For each: {"line": <integer id>, "action": "fix"|"explain"|"research"}.
Max 2. Output JSON only — no prose.

Example input:
[L4] def parse(self, x):  # TODO handle None
[L5] Traceback (most recent call last): KeyError 'user_id'
[L6] Top 10 movies of 2026 - you won't believe #3
Example output (L6 is passive → ignored):
{"regions":[{"line":5,"action":"fix"},{"line":4,"action":"fix"}]}`;

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

  constructor(private readonly deps: RegionDetectorDeps) {}

  /** Call on every screen change (sense event). Coalesces a burst into one run. */
  onContextChange(): void {
    if (!this.deps.isEnabled()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
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
      const response = await fetch(`${this.deps.config.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.deps.config.model,
          messages: [
            { role: "system", content: SLM_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: "json", // Ollama structured output — keeps small models valid
          options: { num_predict: this.deps.config.maxTokens, temperature: 0.2 },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text()}`);

      const data = await response.json() as { message?: { content?: string } };
      const content = data.message?.content?.trim() || "";
      const latencyMs = Date.now() - start;
      this.lastLatencyMs = latencyMs;
      this.runs++;

      let parsed: any;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* */ } } }

      // Provisional eyes: the line-id gives the exact anchor; the LABEL is a
      // templated placeholder (the SLM's own prose is ignored). The main lane
      // upgrades these to real descriptions.
      const regions = resolveLineRegions(parsed?.regions, lines, {
        provisional: true,
        maxRegions: MAX_REGIONS,
        placeholder: (l) => placeholderFor(l.app, l.text),
      });

      // A newer run aborted us mid-flight (controller swapped) — discard.
      if (this.inflight !== controller) {
        debug(TAG, `superseded run discarded (${latencyMs}ms)`);
        return;
      }
      if (!this.deps.isEnabled()) return;

      log(TAG, `detect #${this.runs} ${latencyMs}ms model=${this.deps.config.model} ${lines.length} lines → ${regions?.length ?? 0} region(s)${regions?.length ? ": " + regions.map(r => `"${r.issue.slice(0, 36)}"`).join("; ") : ""}`);
      // Always call (even with undefined) so RegionTracker expiry advances.
      this.deps.onRegions(regions, ctx);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        debug(TAG, "generation aborted (superseded or timed out)");
      } else {
        error(TAG, `ollama call failed: ${err?.message ?? err}`);
      }
    } finally {
      clearTimeout(timeout);
      this.running = false;
      if (this.inflight === controller) this.inflight = null;
    }
  }

  stats(): { runs: number; lastLatencyMs: number } {
    return { runs: this.runs, lastLatencyMs: this.lastLatencyMs };
  }
}
