/** Timestamped structured logger — writes to stderr for easy piping */

const DEBUG = process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug";

// SECURITY: user content (transcripts, OCR, messages, distilled summaries) must
// NOT land in the persistent session log (start.sh pipes stdout → backend.log).
// `preview()` logs only a length by default; opt into truncated plaintext with
// SINAIN_LOG_CONTENT=true for local debugging.
const LOG_CONTENT = process.env.SINAIN_LOG_CONTENT === "true";

/** Length summary by default; truncated plaintext only when SINAIN_LOG_CONTENT=true. */
export function preview(s: string | undefined | null, max = 80): string {
  const str = s ?? "";
  return LOG_CONTENT ? JSON.stringify(str.slice(0, max)) : `${str.length} chars`;
}

function ts(): string {
  return new Date().toISOString();
}

export function debug(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.log(`[${ts()}] [${tag}] 🐛`, ...args);
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [${tag}]`, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[${ts()}] [${tag}] \u26a0`, ...args);
}

export function error(tag: string, ...args: unknown[]): void {
  console.error(`[${ts()}] [${tag}] \u2718`, ...args);
}
