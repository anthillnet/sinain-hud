/** Timestamped structured logger — writes to stderr for easy piping */

import { format } from "node:util";
import { redactText } from "./privacy/redact.js";

const DEBUG = process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug";

// SECURITY: user content (transcripts, OCR, messages, distilled summaries) must
// NOT land in the persistent session log (start.sh pipes stdout → backend.log).
// `preview()` logs only a length by default; opt into truncated plaintext with
// SINAIN_LOG_CONTENT=true for local debugging.
const LOG_CONTENT = process.env.SINAIN_LOG_CONTENT === "true";
const LOG_RAW = process.env.SINAIN_LOG_RAW === "true";

/** Length summary by default; truncated plaintext only when SINAIN_LOG_CONTENT=true. */
export function preview(s: string | undefined | null, max = 80): string {
  const str = s ?? "";
  return LOG_CONTENT ? JSON.stringify(str.slice(0, max)) : `${str.length} chars`;
}

export function logSnippet(text: string, max = 60): string {
  const suffix = text.length > max ? "..." : "";
  return JSON.stringify(redactText(text.slice(0, max)) + suffix);
}

function line(tag: string, marker: string, args: unknown[]): string {
  const formatted = `[${ts()}] [${tag}]${marker} ${format(...args)}`;
  return LOG_RAW ? formatted : redactText(formatted);
}

function ts(): string {
  return new Date().toISOString();
}

export function debug(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.log(line(tag, " 🐛", args));
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(line(tag, "", args));
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(line(tag, " \u26a0", args));
}

export function error(tag: string, ...args: unknown[]): void {
  console.error(line(tag, " \u2718", args));
}
