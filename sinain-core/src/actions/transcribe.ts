import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedItem, SenseEvent, AgentEntry, ContextWindow } from "../types.js";
import type { Action, ActionStatus, ActionProgress, ActionInfo, ActionContext } from "./types.js";
import { log, error } from "../log.js";

const TAG = "action:transcribe";

interface Segment {
  text: string;
  ts: number;
  app: string;
}

export class TranscribeAction implements Action {
  readonly id: string;
  readonly name = "transcribe";

  private _status: ActionStatus = "pending";
  private _progress: ActionProgress = { pct: null, message: "Waiting to start..." };
  private startedAt = 0;
  private stoppedAt: number | null = null;
  private label: string;
  private ctx: ActionContext | null = null;

  private segments: Segment[] = [];
  private lastApp = "";

  constructor(id: string, args: string[]) {
    this.id = id;
    this.label = args.join(" ").trim();
  }

  get status(): ActionStatus { return this._status; }
  get progress(): ActionProgress { return this._progress; }

  async start(ctx: ActionContext): Promise<void> {
    this.ctx = ctx;
    this._status = "running";
    this.startedAt = Date.now();
    this._progress = { pct: null, message: "Transcribing... 0 segments" };
    log(TAG, `started${this.label ? ` [${this.label}]` : ""}`);
  }

  async stop(): Promise<string> {
    this.stoppedAt = Date.now();
    this._status = "completed";

    if (this.segments.length === 0) {
      this._progress = { pct: 100, message: "No audio captured." };
      return "No audio segments were captured during this session.";
    }

    const filePath = this.writeMarkdown();
    const durationS = Math.round((this.stoppedAt - this.startedAt) / 1000);
    const summary = `Transcription saved: ${filePath} (${this.segments.length} segments, ${durationS}s)`;
    this._progress = { pct: 100, message: summary };
    log(TAG, summary);
    return summary;
  }

  onFeedItem(item: FeedItem): void {
    if (this._status !== "running") return;
    if (item.source !== "audio") return;

    // Strip the [📝] prefix that feedBuffer adds
    const text = item.text.replace(/^\[📝\]\s*/, "").trim();
    if (!text) return;

    this.segments.push({ text, ts: item.ts, app: this.lastApp });

    const elapsedS = Math.round((Date.now() - this.startedAt) / 1000);
    this._progress = {
      pct: null,
      message: `Transcribing... ${this.segments.length} segments (${elapsedS}s)`,
    };
  }

  onSenseEvent(event: SenseEvent): void {
    if (this._status !== "running") return;
    if (event.meta.app) {
      this.lastApp = event.meta.app;
    }
  }

  onAgentTick(_entry: AgentEntry, _ctx: ContextWindow): void {
    // No-op for transcription — could annotate with digest later
  }

  getInfo(): ActionInfo {
    return {
      id: this.id,
      name: this.name,
      status: this._status,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      progress: this._progress,
      meta: {
        label: this.label || null,
        segmentCount: this.segments.length,
      },
    };
  }

  // ── Private ──

  private writeMarkdown(): string {
    const ctx = this.ctx!;
    mkdirSync(ctx.outputDir, { recursive: true });

    const now = new Date();
    const datePart = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
    const labelSlug = this.label
      ? "-" + this.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")
      : "";
    const fileName = `transcript-${datePart}${labelSlug}.md`;
    const filePath = join(ctx.outputDir, fileName);

    const lines: string[] = [];
    const header = this.label || "Meeting Transcript";
    lines.push(`# ${header}`);
    lines.push("");
    lines.push(`**Date:** ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`);
    lines.push(`**Duration:** ${Math.round((this.stoppedAt! - this.startedAt) / 1000)}s`);
    lines.push(`**Segments:** ${this.segments.length}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    // Group segments into 60-second blocks
    const blockMs = 60_000;
    let blockStart = this.segments[0].ts;
    let currentApp = "";

    for (const seg of this.segments) {
      // Start new block if 60s elapsed
      if (seg.ts - blockStart >= blockMs) {
        blockStart = seg.ts;
        lines.push("");
      }

      const elapsed = Math.round((seg.ts - this.startedAt) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      const timestamp = `${mm}:${ss}`;

      // Annotate app context changes
      if (seg.app && seg.app !== currentApp) {
        currentApp = seg.app;
        lines.push(`> *[${currentApp}]*`);
      }

      lines.push(`**[${timestamp}]** ${seg.text}`);
    }

    lines.push("");

    try {
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    } catch (err) {
      error(TAG, "failed to write transcript:", err);
      throw err;
    }

    return filePath;
  }
}
