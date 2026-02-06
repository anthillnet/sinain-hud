import type { FeedItem, SenseEvent, RecordCommand, RecorderStatus, StopResult } from "./types.js";
import { log, warn } from "./log.js";

const TAG = "recorder";

/**
 * Recorder collects audio transcripts during a recording session.
 *
 * Usage:
 * - handleCommand({command: "start", label: "Meeting"}) → starts recording
 * - onFeedItem() → called for each audio transcript, collects if recording
 * - onSenseEvent() → tracks app context for title detection
 * - handleCommand({command: "stop"}) → stops recording, returns StopResult with transcript
 * - getStatus() → returns current RecorderStatus for prompt injection
 */
export class Recorder {
  private recording = false;
  private label: string | null = null;
  private startedAt: number | null = null;
  private segments: { text: string; ts: number }[] = [];
  private lastApp: string = "";
  private lastWindowTitle: string = "";

  /**
   * Handle a record command from the analyzer.
   * Returns StopResult on stop if there are segments, otherwise undefined.
   */
  handleCommand(cmd: RecordCommand | undefined): StopResult | undefined {
    if (!cmd) return undefined;

    if (cmd.command === "start") {
      return this.start(cmd.label);
    } else if (cmd.command === "stop") {
      return this.stop();
    }
    return undefined;
  }

  /**
   * Start a new recording session.
   */
  private start(label?: string): undefined {
    if (this.recording) {
      log(TAG, `already recording "${this.label}" — ignoring start`);
      return undefined;
    }

    this.recording = true;
    this.label = label || null;
    this.startedAt = Date.now();
    this.segments = [];

    const labelStr = label ? ` "${label}"` : "";
    log(TAG, `started recording${labelStr}`);
    return undefined;
  }

  /**
   * Stop recording and return the collected transcript.
   */
  private stop(): StopResult | undefined {
    if (!this.recording) {
      log(TAG, "not recording — ignoring stop");
      return undefined;
    }

    const title = this.buildTitle();
    const transcript = this.buildTranscript();
    const segments = this.segments.length;
    const durationS = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;

    // Reset state
    this.recording = false;
    this.label = null;
    this.startedAt = null;
    this.segments = [];

    log(TAG, `stopped recording: "${title}" (${segments} segments, ${durationS}s)`);

    if (segments === 0) {
      log(TAG, "no segments captured — returning undefined");
      return undefined;
    }

    return { title, transcript, segments, durationS };
  }

  /**
   * Called for each audio FeedItem. Collects if recording.
   */
  onFeedItem(item: FeedItem): void {
    if (!this.recording) return;
    if (item.source !== "audio") return;
    if (!item.text || item.text.trim().length === 0) return;

    // Strip the [📝] prefix if present
    let text = item.text;
    if (text.startsWith("[📝] ")) {
      text = text.slice(5);
    }

    this.segments.push({ text: text.trim(), ts: item.ts });
  }

  /**
   * Called for each SenseEvent. Tracks app context for title.
   */
  onSenseEvent(event: SenseEvent): void {
    if (event.meta.app) {
      this.lastApp = event.meta.app;
    }
    if (event.meta.windowTitle) {
      this.lastWindowTitle = event.meta.windowTitle;
    }
  }

  /**
   * Get current recorder status for prompt injection.
   */
  getStatus(): RecorderStatus {
    return {
      recording: this.recording,
      label: this.label,
      startedAt: this.startedAt,
      segments: this.segments.length,
      durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Build a title from label or app context.
   */
  private buildTitle(): string {
    if (this.label) return this.label;

    // Try to build from app context
    const app = this.lastApp.replace(/\.app$/i, "").trim();
    if (app) {
      // Common meeting apps
      if (/zoom|meet|teams|slack|discord/i.test(app)) {
        return `${app} call`;
      }
      return `Recording in ${app}`;
    }

    // Fallback with timestamp
    const now = new Date();
    return `Recording ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  }

  /**
   * Build transcript from collected segments.
   * Format: [MM:SS] text
   */
  private buildTranscript(): string {
    if (this.segments.length === 0) return "";
    if (!this.startedAt) return this.segments.map(s => s.text).join("\n");

    const baseTs = this.startedAt;
    return this.segments
      .map(s => {
        const offsetMs = s.ts - baseTs;
        const offsetSec = Math.max(0, Math.floor(offsetMs / 1000));
        const min = Math.floor(offsetSec / 60);
        const sec = offsetSec % 60;
        const timestamp = `[${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
        return `${timestamp} ${s.text}`;
      })
      .join("\n");
  }

  /**
   * Force stop recording (e.g., on shutdown).
   */
  forceStop(): StopResult | undefined {
    if (this.recording) {
      warn(TAG, "force stopping recording");
      return this.stop();
    }
    return undefined;
  }
}
