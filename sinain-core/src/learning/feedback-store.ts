import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FeedbackRecord, FeedbackSignals } from "../types.js";
import { log, error } from "../log.js";

const TAG = "feedback-store";

/**
 * Persistent JSONL feedback log — one file per day.
 * Follows TraceStore pattern: daily rotation, WriteStream append.
 *
 * Storage: ~/.sinain-core/feedback/2025-02-03.jsonl
 *
 * Records are written at escalation time with null signals, then
 * patched in-place by SignalCollector once deferred feedback arrives.
 */
export class FeedbackStore {
  private dir: string;
  private currentDate = "";
  private currentStream: fs.WriteStream | null = null;
  private retentionDays: number;

  constructor(dir: string, retentionDays = 30) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        error(TAG, "failed to create feedback dir:", err.message);
      }
    }
  }

  /** Create a new FeedbackRecord with null signals. */
  createRecord(params: {
    tickId: number;
    digest: string;
    hud: string;
    currentApp: string;
    escalationScore: number;
    escalationReasons: string[];
    codingContext: boolean;
    escalationMessage: string;
    openclawResponse: string;
    responseLatencyMs: number;
  }): FeedbackRecord {
    const record: FeedbackRecord = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      tickId: params.tickId,
      digest: params.digest.slice(0, 2048),
      hud: params.hud,
      currentApp: params.currentApp,
      escalationScore: params.escalationScore,
      escalationReasons: params.escalationReasons,
      codingContext: params.codingContext,
      escalationMessage: params.escalationMessage.slice(0, 2048),
      openclawResponse: params.openclawResponse.slice(0, 2048),
      responseLatencyMs: params.responseLatencyMs,
      signals: {
        errorCleared: null,
        noReEscalation: null,
        dwellTimeMs: null,
        quickAppSwitch: null,
        compositeScore: 0,
      },
      tags: this.deriveTags(params),
    };
    return record;
  }

  /** Append a record to today's JSONL file. */
  append(record: FeedbackRecord): void {
    try {
      this.rotateIfNeeded();
      if (this.currentStream) {
        this.currentStream.write(JSON.stringify(record) + "\n");
      }
    } catch (err: any) {
      error(TAG, "append failed:", err.message);
    }
  }

  /** Update signals for a record by ID. Reads + rewrites the day's file. */
  updateSignals(recordId: string, date: string, signals: FeedbackSignals): boolean {
    const filePath = path.join(this.dir, `${date}.jsonl`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      let updated = false;

      const newLines = lines.map(line => {
        if (!line.trim()) return line;
        try {
          const rec = JSON.parse(line) as FeedbackRecord;
          if (rec.id === recordId) {
            rec.signals = signals;
            updated = true;
            return JSON.stringify(rec);
          }
        } catch { /* skip malformed lines */ }
        return line;
      });

      if (updated) {
        fs.writeFileSync(filePath, newLines.join("\n"));
        // If the stream points to this file, re-open it
        if (date === this.currentDate) {
          this.currentStream?.end();
          this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
        }
      }
      return updated;
    } catch {
      return false;
    }
  }

  /** Read all records for a given date. */
  queryDay(date: string): FeedbackRecord[] {
    const filePath = path.join(this.dir, `${date}.jsonl`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return content.split("\n")
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as FeedbackRecord);
    } catch {
      return [];
    }
  }

  /** Read recent records across today and yesterday. */
  queryRecent(limit = 20): FeedbackRecord[] {
    const results: FeedbackRecord[] = [];
    const today = new Date();

    // Check today and up to 6 previous days to fill the limit
    for (let d = 0; d < 7 && results.length < limit; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - d);
      const dateStr = date.toISOString().slice(0, 10);
      const dayRecords = this.queryDay(dateStr);
      results.push(...dayRecords);
    }

    // Sort newest first, truncate
    return results.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /** Aggregate stats across recent records. */
  getStats(): Record<string, unknown> {
    const records = this.queryRecent(100);
    if (records.length === 0) {
      return { totalRecords: 0, withSignals: 0, avgCompositeScore: null };
    }

    const withSignals = records.filter(r => r.signals.compositeScore !== 0 || r.signals.errorCleared !== null);
    const scores = withSignals.map(r => r.signals.compositeScore).filter(s => s !== 0);
    const avgScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;

    // Tag distribution
    const tagCounts: Record<string, number> = {};
    for (const r of records) {
      for (const t of r.tags) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }

    return {
      totalRecords: records.length,
      withSignals: withSignals.length,
      avgCompositeScore: avgScore !== null ? Math.round(avgScore * 1000) / 1000 : null,
      avgLatencyMs: Math.round(records.reduce((s, r) => s + r.responseLatencyMs, 0) / records.length),
      topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    };
  }

  /** Close the write stream. */
  destroy(): void {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
  }

  /** Prune files older than retentionDays. */
  prune(): number {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    let pruned = 0;
    try {
      for (const file of fs.readdirSync(this.dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const dateStr = file.replace(".jsonl", "");
        const fileDate = new Date(dateStr).getTime();
        if (fileDate && fileDate < cutoff) {
          fs.unlinkSync(path.join(this.dir, file));
          pruned++;
        }
      }
      if (pruned > 0) log(TAG, `pruned ${pruned} old feedback files`);
    } catch (err: any) {
      error(TAG, "prune failed:", err.message);
    }
    return pruned;
  }

  // ── Private ──

  private rotateIfNeeded(): void {
    const date = new Date().toISOString().slice(0, 10);
    if (date !== this.currentDate) {
      if (this.currentStream) {
        this.currentStream.end();
      }
      const filePath = path.join(this.dir, `${date}.jsonl`);
      this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
      this.currentDate = date;
      log(TAG, `writing to ${filePath}`);
    }
  }

  private deriveTags(params: {
    escalationReasons: string[];
    currentApp: string;
    codingContext: boolean;
  }): string[] {
    const tags: string[] = [];

    // From escalation reasons
    for (const r of params.escalationReasons) {
      const category = r.split(":")[0];
      if (category && !tags.includes(category)) {
        tags.push(category);
      }
    }

    // App category
    if (params.currentApp) {
      tags.push(`app:${params.currentApp.toLowerCase().slice(0, 30)}`);
    }

    // Coding context
    if (params.codingContext) {
      tags.push("coding");
    }

    return tags;
  }
}
