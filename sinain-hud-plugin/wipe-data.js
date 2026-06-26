// `sinain wipe` — erase on-device user CONTENT (knowledge graph, transcripts,
// screen OCR, captured frames, traces, feedback, situation snapshot, logs).
//
// Deliberately preserves config + credentials so the app still works afterward:
// ~/.sinain/.env, agents.json, auth-profiles.json, device-identity.json, and
// the installed binaries/overlay are NOT touched. Use --include-config to also
// remove configuration.
import fs from "fs";
import os from "os";
import net from "net";
import path from "path";
import readline from "readline";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const BOLD = "\x1b[1m", GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";

const argv = process.argv.slice(3);
const assumeYes = argv.includes("--yes") || argv.includes("-y");
const includeConfig = argv.includes("--include-config");

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    for (const e of fs.readdirSync(p)) total += dirSize(path.join(p, e));
  } catch { /* gone / unreadable */ }
  return total;
}
function human(n) {
  return n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(400);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1");
  });
}
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

// On-device CONTENT (privacy wipe). Config/keys/binaries preserved by default.
const contentTargets = [
  path.join(SINAIN_DIR, "memory"),                              // knowledge graph, raw chunks, daily notes, pending-session
  path.join(SINAIN_DIR, "capture"),                             // frame.jpg + meta.json
  path.join(SINAIN_DIR, "logs"),                                // backend.log
  path.join(HOME, ".sinain-core", "traces"),
  path.join(HOME, ".sinain-core", "feedback"),
  path.join(HOME, ".openclaw", "workspace", "SITUATION.md"),
];
const configTargets = [
  path.join(SINAIN_DIR, ".env"),
  path.join(SINAIN_DIR, "sinain-core", ".env"),
  path.join(SINAIN_DIR, "agents.json"),
  path.join(SINAIN_DIR, "auth-profiles.json"),
  path.join(SINAIN_DIR, "device-identity.json"),
];

async function main() {
  // Refuse while services are running — the knowledge store holds exclusive
  // file locks (Oxigraph/SQLite) and deleting under a live process corrupts state.
  if (await portOpen(9500)) {
    console.error(`${RED}✗${RESET} sinain-core is running on :9500.`);
    console.error(`  Run ${BOLD}sinain stop${RESET} first, then ${BOLD}sinain wipe${RESET}.`);
    process.exit(1);
  }

  const targets = includeConfig ? [...contentTargets, ...configTargets] : contentTargets;
  const present = targets.filter(fs.existsSync);

  console.log(`\n${BOLD}sinain wipe${RESET} — erase on-device ${includeConfig ? "data + config" : "user content"}\n`);
  if (present.length === 0) {
    console.log(`${GREEN}✓${RESET} Nothing to wipe — no local data found.`);
    return;
  }
  let total = 0;
  for (const t of present) {
    const sz = dirSize(t);
    total += sz;
    console.log(`  ${RED}✗${RESET} ${t.replace(HOME, "~")}  ${DIM}(${human(sz)})${RESET}`);
  }
  console.log(`\n  Total: ${BOLD}${human(total)}${RESET}`);
  if (!includeConfig) {
    console.log(`  ${DIM}Preserved: .env, agents.json, auth-profiles.json, device-identity.json (use --include-config to remove)${RESET}`);
  }
  console.log(`\n${YELLOW}This cannot be undone.${RESET}`);

  if (!assumeYes) {
    const answer = await confirm(`Type ${BOLD}wipe${RESET} to confirm: `);
    if (answer !== "wipe") {
      console.log(`${DIM}Aborted — nothing removed.${RESET}`);
      process.exit(0);
    }
  }

  let removed = 0;
  for (const t of present) {
    try { fs.rmSync(t, { recursive: true, force: true }); removed++; }
    catch (e) { console.error(`  ${RED}✗${RESET} failed to remove ${t}: ${e.message}`); }
  }
  console.log(`\n${GREEN}✓${RESET} Wiped ${removed} item(s), ${human(total)} freed.`);
}

await main();
