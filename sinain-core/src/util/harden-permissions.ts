import { chmodSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.js";

const TAG = "perms";

// Owner-only. Restricting the *directory* node blocks other local users from
// traversing in at all, without touching the mode of any executable stored
// within — so it's safe to apply broadly. File mode is owner read/write.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function chmodSafe(p: string, mode: number): void {
  try { chmodSync(p, mode); } catch { /* best-effort: never block startup */ }
}

/**
 * Recursively tighten a DATA-ONLY tree (no executables expected): dirs → 0700,
 * files → 0600. Skips symlinks; bounded depth; best-effort per node.
 */
function tightenTree(p: string, depth = 0): void {
  if (depth > 16) return;
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSafe(p, DIR_MODE);
    let entries: string[] = [];
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) tightenTree(join(p, e), depth + 1);
  } else if (st.isFile()) {
    chmodSafe(p, FILE_MODE);
  }
}

/**
 * Tighten permissions on on-device user data so it is not world/group-readable.
 * Runs once at startup and is best-effort (never throws). The process umask
 * (set at the top of index.ts) keeps *newly* created files private; this pass
 * fixes files left world-readable by older builds.
 */
export function hardenLocalDataPermissions(): void {
  const home = homedir();

  // 1. Container dirs — owner-only traversal blocks other users wholesale.
  const containers = [
    join(home, ".sinain"),
    join(home, ".sinain", "sinain-core"),
    join(home, ".sinain", "capture"),
    join(home, ".sinain-core"),
    join(home, ".openclaw"),
    join(home, ".openclaw", "workspace"),
  ];
  for (const d of containers) if (existsSync(d)) chmodSafe(d, DIR_MODE);

  // 2. Data-only trees — recurse and tighten every file + subdir.
  const dataTrees = [
    join(home, ".sinain", "memory"),
    join(home, ".sinain", "capture"),
    join(home, ".sinain-core", "traces"),
    join(home, ".sinain-core", "feedback"),
  ];
  if (process.env.SINAIN_MEMORY_DIR) dataTrees.push(process.env.SINAIN_MEMORY_DIR);
  for (const t of dataTrees) if (existsSync(t)) tightenTree(t);

  // 3. Known-sensitive individual files (secrets + rich-context docs).
  const files = [
    join(home, ".sinain", ".env"),
    join(home, ".sinain", "sinain-core", ".env"),
    join(home, ".sinain", "agents.json"),
    join(home, ".sinain", "auth-profiles.json"),
    join(home, ".sinain", "device-identity.json"),
    join(home, ".openclaw", "workspace", "SITUATION.md"),
  ];
  for (const f of files) if (existsSync(f)) chmodSafe(f, FILE_MODE);

  log(TAG, "tightened on-device data permissions (dirs 0700, files 0600)");
}
