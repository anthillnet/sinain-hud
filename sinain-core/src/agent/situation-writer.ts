import fs from "node:fs";
import path from "node:path";
import type { ContextWindow, AgentEntry, RecorderStatus } from "../types.js";
import type { EscalationScore } from "../escalation/scorer.js";
import { normalizeAppName } from "./context-window.js";
import { log, error } from "../log.js";

const TAG = "situation";

/**
 * Error stack trace patterns for extraction.
 */
const ERROR_STACK_PATTERNS = [
  /Error:.*\n(\s+at\s+.*\n)+/g,      // JavaScript stack traces
  /Traceback.*:\n(\s+File.*\n)+/gi,  // Python tracebacks
  /panic:.*\n(\s+goroutine.*\n)?/g,  // Go panics
  /Exception.*:\n(\s+at\s+.*\n)+/g,  // Java exceptions
];

/**
 * Extract error stack traces from text.
 */
function extractErrors(text: string): string[] {
  const errors: string[] = [];
  for (const pattern of ERROR_STACK_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) errors.push(...matches.map(m => m.slice(0, 500)));
  }
  return errors;
}

/**
 * Atomically write SITUATION.md for OpenClaw bootstrap.
 * Ported from relay's writeSituationMd() — uses write-then-rename for atomicity.
 *
 * Enhanced with:
 * - Escalation context (score and reasons)
 * - Detected errors section
 * - Active recording status
 */
export function writeSituationMd(
  situationMdPath: string,
  contextWindow: ContextWindow,
  digest: string,
  entry: AgentEntry,
  escalationScore?: EscalationScore,
  recorderStatus?: RecorderStatus | null,
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

  // Enhanced: Escalation context for richer understanding
  if (escalationScore && escalationScore.total > 0) {
    lines.push("## Escalation Context");
    lines.push("");
    lines.push(`- Score: ${escalationScore.total}`);
    lines.push(`- Reasons: ${escalationScore.reasons.join(", ") || "none"}`);
    lines.push("");
  }

  // Enhanced: Detected errors section
  const allText = [
    digest,
    ...contextWindow.screen.map(e => e.ocr || ""),
    ...contextWindow.audio.map(e => e.text || ""),
  ].join("\n");
  const detectedErrors = extractErrors(allText);
  if (detectedErrors.length > 0) {
    lines.push("## Detected Errors");
    lines.push("");
    for (const err of detectedErrors.slice(0, 3)) {
      lines.push("```");
      lines.push(err.trim());
      lines.push("```");
      lines.push("");
    }
  }

  // Enhanced: Active recording status
  if (recorderStatus?.recording) {
    lines.push("## Active Recording");
    lines.push("");
    const label = recorderStatus.label || "Unnamed recording";
    const durationSec = Math.round(recorderStatus.durationMs / 1000);
    lines.push(`- Label: ${label}`);
    lines.push(`- Duration: ${durationSec}s`);
    lines.push(`- Segments: ${recorderStatus.segments}`);
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
