import fs from "node:fs";
import path from "node:path";
import type { Trace } from "../types.js";
import { log, error } from "../log.js";

const TAG = "trace-store";

/**
 * Persistent JSONL trace log.
 * Each day gets its own file: ~/.sinain-core/traces/2025-02-03.jsonl
 *
 * Format enables:
 *   cat traces/2025-02-03.jsonl | jq '.metrics.totalLatencyMs'
 *   Replay in eval harness
 *   Import into dashboards
 */
export class TraceStore {
  private dir: string;
  private currentDate = "";
  private currentStream: fs.WriteStream | null = null;

  constructor(dir: string) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        error(TAG, "failed to create trace dir:", err.message);
      }
    }
  }

  /** Append a trace to today's JSONL file. */
  append(trace: Trace): void {
    const date = new Date().toISOString().slice(0, 10);

    // Rotate file on date change
    if (date !== this.currentDate) {
      if (this.currentStream) {
        this.currentStream.end();
      }
      const filePath = path.join(this.dir, `${date}.jsonl`);
      this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
      this.currentDate = date;
      log(TAG, `writing to ${filePath}`);
    }

    if (this.currentStream) {
      this.currentStream.write(JSON.stringify(trace) + "\n");
    }
  }

  /** Read all traces for a given date. */
  queryDay(date: string): Trace[] {
    const filePath = path.join(this.dir, `${date}.jsonl`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return content.split("\n")
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as Trace);
    } catch {
      return [];
    }
  }

  /** Close the write stream. */
  destroy(): void {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
  }
}
