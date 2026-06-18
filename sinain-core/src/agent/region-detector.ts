import type { ContextWindow, RawRegion, RegionSlmConfig } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { buildContextWindow } from "./context-window.js";
import { buildUserPrompt, parseRegions } from "./analyzer.js";
import { log, debug, error } from "../log.js";

const TAG = "region-slm";

/**
 * Regions-only system prompt for a small local model. Deliberately short and
 * explicit — SLMs follow a tight schema far better than a long discursive one.
 * No hud/digest/record: this lane does ONE job, so the model spends its budget
 * on regions and returns fast. `format: json` (Ollama) constrains the output.
 */
const SLM_SYSTEM_PROMPT = `You find actionable things on a user's screen and return JSON only.

Input: screen OCR lines, each tagged "[S<id>] [app] text".

A region is anything an agent could genuinely help with — an error, a typo, a
bug, a question, a form, code being edited, a term being read, a draft being
written, a command the user seems unsure of. Be generous but concrete.

Each region object has:
- "issue": ≤10 words quoting the on-screen text it refers to
- "tip": one sentence — what an agent could do about it
- "action": one of "fix" | "explain" | "research"
- "sourceId": the integer from the [S<id>] prefix of the line where it appears

Rules: max 3 regions, one per distinct thing, only things actually visible.
If the screen is empty or idle, return {"regions":[]}. Output JSON only — no prose.

Example input line: [S7] [Terminal] error TS2339: Property 'foo' does not exist
Example output:
{"regions":[{"issue":"error TS2339: Property 'foo' does not exist","tip":"Add the missing 'foo' property to the type or fix the reference.","action":"fix","sourceId":7}]}`;

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
    // Drop frames with no real OCR: buildUserPrompt renders them as "(no text)"
    // placeholder lines, and a small model latches onto those as if they were
    // content (emitting bogus issue="(no text)" eyes). The cloud model ignores
    // them; the SLM needs them gone. Skip entirely if nothing has real text.
    const screen = ctx.screen.filter(e => e.ocr && e.ocr.trim().length > 0);
    if (screen.length === 0) return;
    const leanCtx: ContextWindow = { ...ctx, screen };

    const userPrompt = buildUserPrompt(leanCtx, null, /* withSourceIds */ true);
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

      let regions: RawRegion[] | undefined;
      try {
        regions = parseRegions(JSON.parse(content));
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { regions = parseRegions(JSON.parse(m[0])); } catch { /* unparseable */ } }
      }

      // A newer run aborted us mid-flight (controller swapped) — discard, the
      // newer run owns the screen now.
      if (this.inflight !== controller) {
        debug(TAG, `superseded run discarded (${latencyMs}ms)`);
        return;
      }
      if (!this.deps.isEnabled()) return;

      log(TAG, `detect #${this.runs} ${latencyMs}ms model=${this.deps.config.model} → ${regions?.length ?? 0} region(s)${regions?.length ? ": " + regions.map(r => `"${r.issue.slice(0, 32)}" src=${r.sourceId ?? "-"}`).join("; ") : ""}`);
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
