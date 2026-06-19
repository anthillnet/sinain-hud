import type { ContextWindow, RawRegion, RegionSlmConfig } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { buildContextWindow } from "./context-window.js";
import { log, debug, error } from "../log.js";

const TAG = "region-slm";
const REGION_ACTIONS = new Set(["fix", "explain", "research"]);
const MAX_LINES = 40;   // OCR lines offered to the model per tick
const MAX_REGIONS = 2;  // quality over quantity — better to surface fewer, real ones

/**
 * Region prompt for a small local model. The model picks the LINE-ID of an
 * actionable on-screen line and writes a clean DESCRIPTION (not a quote) — the
 * tracker anchors to the line's exact box, so the description is free to be
 * readable rather than parroting (often-imperfect) OCR. Tight schema; SLMs obey
 * a short explicit contract far better than prose. `format: json` constrains it.
 */
const SLM_SYSTEM_PROMPT = `You flag ONLY high-value spots on a user's screen where an assistant could do real, concrete work the user would actually want. Return JSON only.

Input: numbered screen lines, "[L<id>] text".

Most screens need NOTHING — passive reading, browsing, social feeds, chat
scrollback, menus. Returning {"regions":[]} is the correct, common answer. Be
strict: when unsure, emit nothing.

FLAG only clear, high-value things:
- an error / failure / stack trace / warning
- a question or problem the user is visibly trying to solve
- a form / task / command they are actively working through
- code or config with a concrete bug or TODO

Do NOT flag: passive content (feeds, articles, posts, videos), or "quality"
nitpicks (grammar, wording, timestamp/format, "incomplete sentence",
"misleading offer"). Those are noise — skip them.

For each flagged line:
- "line": the integer id
- "issue": a SHORT, CLEAN description in YOUR OWN WORDS (≤10 words). Don't copy
  the raw text; say what it is (OCR may be imperfect — describe the intent).
- "tip": one sentence — the concrete thing an assistant would do
- "action": "fix" | "explain" | "research"

Rules: max 2, only genuinely useful ones. Output JSON only — no prose.

Example input:
[L4] def parse(self, x):  # TODO handle None
[L5] Traceback (most recent call last): KeyError 'user_id'
[L6] Top 10 movies of 2026 - you won't believe #3
Example output (L6 is passive content → ignored):
{"regions":[{"line":5,"issue":"KeyError on 'user_id' in a traceback","tip":"Trace where user_id is read and guard the missing key.","action":"fix"},{"line":4,"issue":"Unhandled None case marked TODO","tip":"Add the None handling the TODO calls for.","action":"fix"}]}`;

/** One OCR line offered to the model, with the geometry to anchor it. */
interface PromptLine {
  bbox: [number, number, number, number];
  text: string;
  frameSize: [number, number];
  app: string;
  display: number;
  ocr: string; // the source event's full OCR (spawn context)
}

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
    // Build the line list the model chooses from: per-line OCR boxes of the
    // CURRENT app's frames (newest first), deduped. Scoping to currentApp avoids
    // detecting the previous app's leftover buffer OCR right after a switch.
    const cur = (ctx.currentApp || "").toLowerCase().trim();
    const lines: PromptLine[] = [];
    const seen = new Set<string>();
    for (const e of ctx.screen) { // newest-first
      const eApp = (e.meta.app || "").toLowerCase().trim();
      if (cur && eApp && eApp !== cur) continue;
      const fs = (e.frameSize && e.frameSize.length === 2) ? e.frameSize as [number, number] : undefined;
      if (!fs || !e.ocrLines?.length) continue;
      for (const l of e.ocrLines) {
        const text = (l.text || "").trim();
        if (text.length < 3 || !Array.isArray(l.bbox) || l.bbox.length !== 4) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({
          bbox: l.bbox as [number, number, number, number],
          text, frameSize: fs,
          app: e.meta.app || ctx.currentApp,
          display: e.meta.screen,
          ocr: e.ocr || "",
        });
        if (lines.length >= MAX_LINES) break;
      }
      if (lines.length >= MAX_LINES) break;
    }
    if (lines.length === 0) return;

    const userPrompt = `Active app: ${ctx.currentApp || "?"}\nScreen lines:\n`
      + lines.map((l, i) => `[L${i}] ${l.text}`).join("\n");
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

      // Map each {line, issue, tip, action} to a pre-resolved RawRegion: the
      // line-id gives the exact anchor box + verbatim text; the issue is the
      // model's clean description.
      let regions: RawRegion[] | undefined;
      if (parsed && Array.isArray(parsed.regions)) {
        regions = parsed.regions
          .map((r: any): RawRegion | null => {
            // Models return the id as 2, "2", or "L2" — extract the digits.
            const li = parseInt(String(r?.line ?? r?.lineId ?? "").replace(/[^0-9]/g, ""), 10);
            const issue = typeof r?.issue === "string" ? r.issue.trim() : "";
            const tip = typeof r?.tip === "string" ? r.tip.trim() : "";
            if (!Number.isInteger(li) || li < 0 || li >= lines.length || !issue) return null;
            const ln = lines[li];
            return {
              issue: issue.slice(0, 200),
              tip: (tip || "Engage with this on screen.").slice(0, 300),
              action: REGION_ACTIONS.has(r?.action) ? r.action : undefined,
              bbox: ln.bbox,
              frameSize: ln.frameSize,
              anchorText: ln.text,
              sourceOcr: ln.ocr,
              app: ln.app,
              display: ln.display,
            };
          })
          .filter((r: RawRegion | null): r is RawRegion => r !== null)
          .slice(0, MAX_REGIONS);
        if (regions && regions.length === 0) regions = undefined;
      }

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
