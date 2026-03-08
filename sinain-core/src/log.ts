/** Timestamped structured logger — writes to stderr for easy piping */

const DEBUG = process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug";

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
