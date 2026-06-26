import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, warn } from "../log.js";

const TAG = "retention";

/** Parse a YYYY-MM-DD prefix from a filename → epoch ms, or 0 if none. */
function dateFromName(file: string): number {
  const m = file.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return 0;
  const t = new Date(m[1]).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Delete date-stamped `*.<ext>` files older than `cutoff` in `dir`. */
function pruneDated(dir: string, ext: string, cutoff: number): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(ext)) continue;
      const t = dateFromName(f);
      if (t && t < cutoff) {
        try { unlinkSync(join(dir, f)); n++; } catch { /* in use / gone */ }
      }
    }
  } catch (e: any) {
    warn(TAG, `prune failed for ${dir}: ${e?.message}`);
  }
  return n;
}

/**
 * Startup retention + transient cleanup (best-effort, never throws). Part of the
 * on-device data-at-rest hardening: sensitive derived artifacts shouldn't linger
 * forever, and a live screenshot must not survive across sessions.
 *
 *  - Daily notes (`<memoryDir>/*.md`) and traces (`~/.sinain-core/traces/*.jsonl`)
 *    older than `retentionDays` are deleted. `retentionDays <= 0` keeps forever.
 *    The knowledge graph itself is NOT pruned (that's the durable store; use the
 *    `sinain wipe` command to clear it).
 *  - A stale capture frame (`~/.sinain/capture/frame.jpg` + meta) from a prior
 *    session is removed if it's older than 60s (won't race a live capture).
 */
export function runRetention(retentionDays: number): void {
  const home = homedir();
  const memoryDir = process.env.SINAIN_MEMORY_DIR || join(home, ".sinain", "memory");

  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const notes = pruneDated(memoryDir, ".md", cutoff);
    const traces = pruneDated(join(home, ".sinain-core", "traces"), ".jsonl", cutoff);
    if (notes || traces) {
      log(TAG, `pruned ${notes} daily note(s) + ${traces} trace file(s) older than ${retentionDays}d`);
    }
  }

  // Drop a stale live screenshot from a previous session (only if not fresh, so
  // a core-only restart won't delete a frame that sck-capture is actively writing).
  for (const f of ["frame.jpg", "meta.json"]) {
    const p = join(home, ".sinain", "capture", f);
    try {
      if (existsSync(p) && Date.now() - statSync(p).mtimeMs > 60_000) unlinkSync(p);
    } catch { /* best-effort */ }
  }
}
