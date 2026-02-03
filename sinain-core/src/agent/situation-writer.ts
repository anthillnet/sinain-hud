import fs from "node:fs";
import path from "node:path";
import type { ContextWindow, AgentEntry } from "../types.js";
import { normalizeAppName } from "./context-window.js";
import { log, error } from "../log.js";

const TAG = "situation";

/**
 * Atomically write SITUATION.md for OpenClaw bootstrap.
 * Ported from relay's writeSituationMd() — uses write-then-rename for atomicity.
 */
export function writeSituationMd(
  situationMdPath: string,
  contextWindow: ContextWindow,
  digest: string,
  entry: AgentEntry,
): void {
  const dir = path.dirname(situationMdPath);
  const tmpPath = situationMdPath + ".tmp";

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      error(TAG, "mkdir failed:", err.message);
      return;
    }
  }

  const now = new Date();
  const lines: string[] = [];

  lines.push("# Situation");
  lines.push("");
  lines.push(`> Auto-updated by sinain-core at ${now.toISOString()}`);
  lines.push(`> Tick #${entry.id} | Latency: ${entry.latencyMs}ms | Model: ${entry.model}`);
  lines.push("");

  lines.push("## Digest");
  lines.push("");
  lines.push(digest);
  lines.push("");

  const currentApp = normalizeAppName(contextWindow.currentApp);
  lines.push("## Active Application");
  lines.push("");
  lines.push(currentApp);
  lines.push("");

  if (contextWindow.appHistory.length > 0) {
    lines.push("## App History");
    lines.push("");
    const appChain = contextWindow.appHistory
      .map(a => normalizeAppName(a.app))
      .join(" -> ");
    lines.push(appChain);
    lines.push("");
  }

  if (contextWindow.screen.length > 0) {
    lines.push("## Screen (OCR)");
    lines.push("");
    for (const e of contextWindow.screen) {
      const app = normalizeAppName(e.meta.app);
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, " ").slice(0, 500) : "(no text)";
      lines.push(`- [${ago}s ago] [${app}] ${ocr}`);
    }
    lines.push("");
  }

  if (contextWindow.audio.length > 0) {
    lines.push("## Audio Transcripts");
    lines.push("");
    for (const e of contextWindow.audio) {
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      lines.push(`- [${ago}s ago] ${e.text.slice(0, 500)}`);
    }
    lines.push("");
  }

  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Screen events in window: ${contextWindow.screenCount}`);
  lines.push(`- Audio events in window: ${contextWindow.audioCount}`);
  lines.push(`- Context window: ${Math.round(contextWindow.windowMs / 1000)}s`);
  lines.push(`- Parsed OK: ${entry.parsedOk}`);
  lines.push("");

  const content = lines.join("\n");

  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, situationMdPath);
  } catch (err: any) {
    error(TAG, "write failed:", err.message);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
