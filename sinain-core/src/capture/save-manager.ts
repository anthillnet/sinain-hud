import { randomBytes } from "node:crypto";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { LocalCurationService } from "../learning/local-curation.js";
import type { SaveProvenance, SaveReceiptMessage } from "../types.js";
import { describeCoverage, type WindowScope } from "./window-ops.js";
import { log, warn } from "../log.js";

const TAG = "save";
const UNDO_WINDOW_MS = 30_000;

/**
 * Deliberate-capture save lifecycle: "remember my last N minutes".
 *
 *   save(N) → broadcast "saving" → distill (LLM, async, seconds)
 *           → broadcast "saved" with fact/entity counts + a 30s undo window
 *           → [undo] broadcast "undone", digest discarded — nothing was written
 *           → [timeout] integrate digest into the knowledge graph → "committed"
 *
 * Integration is deferred, not rolled back: undo is a true cancel. Every save
 * carries a saveId; sessionMeta marks provenance (source: "user_save" for
 * manual gestures, "offered_save" for accepted breakpoint offers — kept
 * distinguishable forever, in the KG and in receipts).
 */
export class SaveManager {
  private pending = new Map<string, { digest: any; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private feedBuffer: FeedBuffer,
    private senseBuffer: SenseBuffer,
    private curation: LocalCurationService,
    private broadcast: (msg: SaveReceiptMessage) => void,
  ) {}

  /** Kick off a save of the last N minutes. Returns the saveId immediately. */
  save(minutes: number, scope?: WindowScope, provenance: SaveProvenance = "user_save"): string {
    const saveId = `save-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const coverage = describeCoverage(this.feedBuffer, this.senseBuffer, minutes, scope);
    this.broadcast({ type: "save_receipt", saveId, status: "saving", minutes, coverage, provenance, ts: Date.now() });
    void this.runSave(saveId, minutes, coverage, scope, provenance);
    return saveId;
  }

  /** Cancel a save inside its undo window. True if there was one to cancel. */
  undo(saveId: string): boolean {
    const entry = this.pending.get(saveId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(saveId);
    log(TAG, `${saveId} undone — digest discarded, nothing written`);
    this.broadcast({ type: "save_receipt", saveId, status: "undone", minutes: 0, coverage: "", ts: Date.now() });
    return true;
  }

  private async runSave(saveId: string, minutes: number, coverage: string, scope?: WindowScope, provenance: SaveProvenance = "user_save"): Promise<void> {
    const fail = (error: string) =>
      this.broadcast({ type: "save_receipt", saveId, status: "error", minutes, coverage, provenance, error, ts: Date.now() });

    try {
      const since = Date.now() - minutes * 60_000;
      // Scope: the chooser's app-selection chips — deselected apps' screen
      // content and (for "mic") audio transcription never reach the distiller.
      const micOk = !scope?.apps || scope.apps.includes("mic");
      let items: Array<{ text: string; ts: number; source: string; channel: string }> = [
        ...this.feedBuffer.queryByTime(since)
          // Audio follows the "mic" chip; non-audio feed (agent narration)
          // is dropped under any scope — it can't be attributed per-app and
          // would leak a deselected app's content into the save.
          .filter((i) => i.source === "audio" ? micOk : !scope?.apps)
          .map((i) => ({
            text: i.text, ts: i.ts, source: i.source, channel: String(i.channel),
          })),
        ...this.curation.senseContextForRange(since, scope?.apps),
      ].sort((a, b) => a.ts - b.ts);

      if (items.length === 0) {
        fail("nothing to save in that range — it was idle");
        return;
      }

      // Bound the distiller's input for multi-hour ranges: keep the most
      // recent items under the char budget (recency > completeness — the
      // older tail was likely covered by incremental distillation already).
      // 120K ≈ the distiller's own 100K LLM cap; anything beyond it would
      // only feed the coref/NEC preprocessing, whose cost grows with item
      // count (measured: 437 items → 7+ min; 110 items → 18s end-to-end).
      const MAX_TRANSCRIPT_CHARS = 120_000;
      let total = 0;
      let cut = items.length;
      for (let i = items.length - 1; i >= 0; i--) {
        total += items[i].text.length;
        if (total > MAX_TRANSCRIPT_CHARS) { cut = i + 1; break; }
        cut = i;
      }
      if (cut >= items.length) {
        // The newest item alone blows the budget (a giant OCR blob) — keep it
        // truncated rather than turning a non-idle range into an empty save.
        const last = items[items.length - 1];
        items = [{ ...last, text: last.text.slice(-MAX_TRANSCRIPT_CHARS) }];
        log(TAG, `${saveId}: single oversized item truncated to ${MAX_TRANSCRIPT_CHARS} chars`);
      } else if (cut > 0) {
        log(TAG, `${saveId}: transcript capped — dropped ${cut} oldest of ${items.length} items (${total} chars)`);
        items = items.slice(cut);
      }

      const digest = await this.curation.distillOnly(items, {
        ts: new Date().toISOString(),
        sessionKey: `user-save-${saveId}`,
        durationMs: minutes * 60_000,
        source: provenance,
        saveId,
      });
      if (!digest) {
        fail("distillation produced nothing for that range");
        return;
      }

      const facts = Array.isArray(digest.facts) ? digest.facts.length : 0;
      const entities = Array.isArray(digest.entities) ? digest.entities.length : 0;

      const timer = setTimeout(() => void this.commit(saveId, minutes, coverage, provenance), UNDO_WINDOW_MS);
      timer.unref?.();
      this.pending.set(saveId, { digest, timer });

      this.broadcast({
        type: "save_receipt", saveId, status: "saved", minutes, coverage,
        facts, entities, undoSeconds: UNDO_WINDOW_MS / 1000, provenance, ts: Date.now(),
      });
      log(TAG, `${saveId}: distilled ${facts} facts / ${entities} entities from ${items.length} items — undo open ${UNDO_WINDOW_MS / 1000}s`);
    } catch (err) {
      warn(TAG, `${saveId} failed: ${String(err).slice(0, 300)}`);
      // Raw errors never reach a card ("distiller failed: Command failed:
      // python3 /Users/…" was shown verbatim once) — one human sentence here,
      // the details live in the session log.
      fail("saving failed — the memory writer hit an error (details in the session log)");
    }
  }

  private async commit(saveId: string, minutes: number, coverage: string, provenance: SaveProvenance = "user_save"): Promise<void> {
    const entry = this.pending.get(saveId);
    if (!entry) return; // undone in the meantime
    this.pending.delete(saveId);
    const ok = await this.curation.integrateDigest(entry.digest);
    this.broadcast({
      type: "save_receipt", saveId, status: ok ? "committed" : "error", minutes, coverage, provenance,
      error: ok ? undefined : "knowledge integration failed", ts: Date.now(),
    });
  }
}
