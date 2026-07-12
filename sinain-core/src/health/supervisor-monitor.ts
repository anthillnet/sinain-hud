// Reads the supervisor's state surface (~/.sinain/supervisor/state.json,
// written by tools/sinaind on every child event and probe tick) so the
// service map can report process-level truth: a child that sinaind gave up
// on (crash-loop → "failed") or is bouncing ("backoff") shows up as a state
// on the eye instead of a silent gap in the data.
//
// Returns null when the stack is unsupervised (no file, stale file, or the
// supervisor pid is gone) — dev runs via plain ./start.sh stay silent.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SupervisedChild {
  state: "running" | "backoff" | "failed" | "stopped" | string;
  pid: number;
  restarts: number;
  lastExit: number | null;
}

export interface SupervisorState {
  pid: number;
  updated: string;
  mode: string;
  children: Record<string, SupervisedChild>;
}

// sinaind rewrites state.json at least every 30s (health-probe tick); a file
// older than this is a dead supervisor that didn't clean up.
const STALE_MS = 3 * 60_000;

const STATE_PATH = join(homedir(), ".sinain", "supervisor", "state.json");

export function readSupervisorState(): SupervisorState | null {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as SupervisorState;
    if (!raw || typeof raw.pid !== "number" || !raw.children) return null;
    if (Date.now() - Date.parse(raw.updated) > STALE_MS) return null;
    process.kill(raw.pid, 0); // throws when the supervisor is gone
    return raw;
  } catch {
    return null;
  }
}
