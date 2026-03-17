#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const HOME       = os.homedir();
const PLUGIN_DIR  = path.join(HOME, ".openclaw/extensions/sinain");
const SOURCES_DIR = path.join(HOME, ".openclaw/sinain-sources");
const OC_JSON     = path.join(HOME, ".openclaw/openclaw.json");
const WORKSPACE   = path.join(HOME, ".openclaw/workspace");

// PKG_DIR = sinain-hud-plugin/ inside the npm package
const PKG_DIR  = path.dirname(new URL(import.meta.url).pathname);
const MEMORY_SRC = path.join(PKG_DIR, "sinain-memory");
const HEARTBEAT  = path.join(PKG_DIR, "HEARTBEAT.md");

console.log("\nInstalling sinain plugin...");

// 1. Copy plugin files
fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.copyFileSync(path.join(PKG_DIR, "index.ts"),             path.join(PLUGIN_DIR, "index.ts"));
fs.copyFileSync(path.join(PKG_DIR, "openclaw.plugin.json"), path.join(PLUGIN_DIR, "openclaw.plugin.json"));
console.log("  ✓ Plugin files copied");

// 2. Copy sinain-memory from bundled package files
fs.mkdirSync(SOURCES_DIR, { recursive: true });
const memoryDst = path.join(SOURCES_DIR, "sinain-memory");
copyDir(MEMORY_SRC, memoryDst);
console.log("  ✓ sinain-memory copied");

// 3. Copy HEARTBEAT.md
fs.copyFileSync(HEARTBEAT, path.join(SOURCES_DIR, "HEARTBEAT.md"));
console.log("  ✓ HEARTBEAT.md copied");

// 4. Install Python deps
const reqFile = path.join(memoryDst, "requirements.txt");
if (fs.existsSync(reqFile)) {
  console.log("  Installing Python dependencies...");
  try {
    execSync(`pip3 install -r "${reqFile}" --quiet`, { stdio: "inherit" });
    console.log("  ✓ Python dependencies installed");
  } catch {
    console.warn("  ⚠ pip3 unavailable — Python eval features disabled");
  }
}

// 5. Patch openclaw.json
let cfg = {};
if (fs.existsSync(OC_JSON)) {
  try { cfg = JSON.parse(fs.readFileSync(OC_JSON, "utf8")); } catch {}
}
cfg.plugins ??= {};
cfg.plugins.entries ??= {};
cfg.plugins.entries["sinain"] = {
  enabled: true,
  config: {
    heartbeatPath: path.join(SOURCES_DIR, "HEARTBEAT.md"),
    memoryPath:    memoryDst,
    sessionKey:    "agent:main:sinain"
  }
};
cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.sandbox ??= {};
cfg.agents.defaults.sandbox.sessionToolsVisibility = "all";
cfg.compaction = { mode: "safeguard", maxHistoryShare: 0.2, reserveTokensFloor: 40000 };
cfg.gateway ??= {};
cfg.gateway.bind = "lan";  // allow remote Mac to connect

fs.mkdirSync(path.dirname(OC_JSON), { recursive: true });
fs.writeFileSync(OC_JSON, JSON.stringify(cfg, null, 2));
console.log("  ✓ openclaw.json patched");

// 6. Memory restore from backup repo (if SINAIN_BACKUP_REPO is set)
const backupUrl = process.env.SINAIN_BACKUP_REPO;
if (backupUrl) {
  try {
    await checkRepoPrivacy(backupUrl);
    if (!fs.existsSync(path.join(WORKSPACE, ".git"))) {
      console.log("  Restoring memory from backup repo...");
      execSync(`git clone "${backupUrl}" "${WORKSPACE}" --quiet`, { stdio: "inherit" });
      console.log("  ✓ Memory restored from", backupUrl);
    } else {
      execSync(`git -C "${WORKSPACE}" remote set-url origin "${backupUrl}"`, { stdio: "pipe" });
      console.log("  ✓ Workspace git remote updated");
    }
  } catch (e) {
    console.error("\n  ✗ Memory restore aborted:", e.message, "\n");
    process.exit(1);
  }
}

// 7. Reload gateway
try {
  execSync("openclaw reload", { stdio: "pipe" });
  console.log("  ✓ Gateway reloaded");
} catch {
  try {
    execSync("openclaw stop && sleep 1 && openclaw start --background", { stdio: "pipe" });
    console.log("  ✓ Gateway restarted");
  } catch {
    console.warn("  ⚠ Could not reload gateway — restart manually");
  }
}

console.log("\n✓ sinain installed successfully.");
console.log("  Plugin config: ~/.openclaw/openclaw.json");
console.log("  Auth token:    check your Brev dashboard → 'Gateway Token'");
console.log("  Then run ./setup-nemoclaw.sh on your Mac.\n");

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    // Skip __pycache__ and .pytest_cache to keep the deploy lean
    if (entry.name === "__pycache__" || entry.name === ".pytest_cache") continue;
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

async function checkRepoPrivacy(url) {
  const m = url.match(/(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^.]+)/);
  if (!m) {
    if (!process.env.SINAIN_BACKUP_REPO_CONFIRMED) {
      throw new Error(
        "Non-GitHub repo: cannot verify privacy.\n" +
        "Set SINAIN_BACKUP_REPO_CONFIRMED=1 only if you are CERTAIN the repo is private."
      );
    }
    return;
  }
  const ownerRepo = m[1].replace(/\.git$/, "");
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${ownerRepo}`);
  } catch (e) {
    throw new Error(`Cannot reach GitHub to verify repo privacy: ${e.message}. Aborting.`);
  }
  if (res.status === 200) {
    const data = await res.json();
    if (!data.private) {
      throw new Error(
        `SECURITY: github.com/${ownerRepo} is PUBLIC.\n` +
        `Make it private: github.com/${ownerRepo}/settings → Change visibility → Private`
      );
    }
  } else if (res.status !== 404) {
    throw new Error(`Cannot verify repo privacy (HTTP ${res.status}). Aborting for safety.`);
  }
  // 404 = private (unauthenticated can't see it) — OK
}
