/** Timestamped structured logger — writes to stderr for easy piping */

function ts(): string {
  return new Date().toISOString();
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
