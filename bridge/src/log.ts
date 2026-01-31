/** Timestamped logger that writes to stdout */

function ts(): string {
  return new Date().toISOString();
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [${tag}]`, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[${ts()}] [${tag}] ⚠`, ...args);
}

export function error(tag: string, ...args: unknown[]): void {
  console.error(`[${ts()}] [${tag}] ✘`, ...args);
}
