import { execFile, type ChildProcess } from "node:child_process";
import type { TtsConfig } from "../types.js";
import { log, warn } from "../log.js";

const TAG = "tts";
const MAX_TEXT_LEN = 500;
const COOLDOWN_MS = 5_000;

/**
 * macOS `say` TTS speaker. Cancel-on-new semantics — only latest insight is spoken.
 */
export class TtsSpeaker {
  private enabled: boolean;
  private voice: string;
  private rate: number;
  private proc: ChildProcess | null = null;
  private lastSpeakTs = 0;
  private broken = false; // set true if `say` not found
  private speaking = false;
  private generation = 0;
  private onSpeakStart?: () => void;
  private onSpeakEnd?: () => void;

  constructor(config: TtsConfig) {
    this.enabled = config.enabled;
    this.voice = config.voice;
    this.rate = config.rate;
  }

  setSuppressCallbacks(onStart: () => void, onEnd: () => void): void {
    this.onSpeakStart = onStart;
    this.onSpeakEnd = onEnd;
  }

  speak(text: string): void {
    if (!this.enabled || this.broken) return;

    // Cooldown — prevent feedback loops
    const now = Date.now();
    if (now - this.lastSpeakTs < COOLDOWN_MS) return;

    // Sanitize: strip [emoji] prefixes, markdown, and truncate
    const clean = text
      .replace(/^\[.+?\]\s*/, "")
      .replace(/[*_~`#>]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown links
      .trim()
      .slice(0, MAX_TEXT_LEN);

    if (!clean) return;

    // Cancel any running speech
    this.cancel();

    this.lastSpeakTs = now;

    const gen = ++this.generation;

    const args: string[] = [];
    if (this.voice) args.push("-v", this.voice);
    if (this.rate) args.push("-r", String(this.rate));
    args.push(clean);

    this.speaking = true;
    this.onSpeakStart?.();

    this.proc = execFile("say", args, (err) => {
      if (gen !== this.generation) return; // stale callback — ignore
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        warn(TAG, "`say` command not found — TTS disabled");
        this.broken = true;
      }
      this.proc = null;
      if (this.speaking) {
        this.speaking = false;
        this.onSpeakEnd?.();
      }
    });
  }

  cancel(): void {
    ++this.generation; // invalidate any pending callback
    if (this.speaking) {
      this.speaking = false;
      this.onSpeakEnd?.();
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled) this.cancel();
    log(TAG, `TTS ${this.enabled ? "enabled" : "disabled"}`);
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  destroy(): void {
    this.cancel();
  }
}
