#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { randomBytes } from "crypto";

const HOME        = os.homedir();
const PLUGIN_DIR  = path.join(HOME, ".openclaw/extensions/sinain-hud");
const SOURCES_DIR = path.join(HOME, ".openclaw/sinain-sources");
const OC_JSON     = path.join(HOME, ".openclaw/openclaw.json");
const WORKSPACE   = path.join(HOME, ".openclaw/workspace");

// PKG_DIR = sinain-hud-plugin/ inside the npm package
const PKG_DIR    = path.dirname(new URL(import.meta.url).pathname);
const MEMORY_SRC = path.join(PKG_DIR, "sinain-memory");
const HEARTBEAT  = path.join(PKG_DIR, "HEARTBEAT.md");
const SKILL      = path.join(PKG_DIR, "SKILL.md");

console.log("\nInstalling sinain plugin...");

// 1. Copy plugin files (remove stale extensions/sinain dir if present from old installs)
const stalePluginDir = path.join(HOME, ".openclaw/extensions/sinain");
if (fs.existsSync(stalePluginDir)) fs.rmSync(stalePluginDir, { recursive: true, force: true });
fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.copyFileSync(path.join(PKG_DIR, "index.ts"),             path.join(PLUGIN_DIR, "index.ts"));
fs.copyFileSync(path.join(PKG_DIR, "openclaw.plugin.json"), path.join(PLUGIN_DIR, "openclaw.plugin.json"));
console.log("  ✓ Plugin files copied");

// 2. Stage sinain-memory
fs.mkdirSync(SOURCES_DIR, { recursive: true });
const memoryDst = path.join(SOURCES_DIR, "sinain-memory");
copyDir(MEMORY_SRC, memoryDst);
console.log("  ✓ sinain-memory copied");

// 3. Stage HEARTBEAT.md and SKILL.md
fs.copyFileSync(HEARTBEAT, path.join(SOURCES_DIR, "HEARTBEAT.md"));
console.log("  ✓ HEARTBEAT.md copied");
fs.copyFileSync(SKILL, path.join(SOURCES_DIR, "SKILL.md"));
console.log("  ✓ SKILL.md copied");

// ── Detect environment and branch ───────────────────────────────────────────

const nemoClaw = detectNemoClaw();
if (nemoClaw) {
  await installNemoClaw(nemoClaw);
} else {
  // 4. Install Python deps (local/bare-metal only — sandbox manages its own)
  const reqFile = path.join(memoryDst, "requirements.txt");
  if (fs.existsSync(reqFile)) {
    console.log("  Installing Python dependencies...");
    try {
      execSync(`pip3 install -r "${reqFile}" --quiet --break-system-packages`, { stdio: "inherit" });
      console.log("  ✓ Python dependencies installed");
    } catch {
      try {
        execSync(`pip3 install -r "${reqFile}" --quiet`, { stdio: "inherit" });
        console.log("  ✓ Python dependencies installed");
      } catch {
        console.warn("  ⚠ pip3 unavailable — Python eval features disabled");
      }
    }
  }
  await installLocal();
}

// ── NemoClaw path: upload staged files into the OpenShell sandbox ────────────
//
// NemoClaw runs OpenClaw inside an OpenShell sandbox pod.  The sandbox has
// outbound network policy (npm registry is blocked at the binary level) so
// `npx` / `npm install` cannot reach registry.npmjs.org from inside the pod.
// Instead we:
//   1. Stage files locally (done above — steps 1-3)
//   2. Upload them into the sandbox via `openshell sandbox upload`
//   3. Download sandbox openclaw.json, patch it, upload back
//   4. Reload the openclaw gateway inside the sandbox over SSH
//   5. Print the sandbox's auth token so setup-nemoclaw.sh can use it

async function installNemoClaw({ sandboxName }) {
  console.log(`\n  NemoClaw sandbox detected: '${sandboxName}'`);

  // Ensure SSH config has an entry for this sandbox
  try {
    const sshEntry = run_capture(`openshell sandbox ssh-config ${sandboxName}`);
    const sshFile  = path.join(HOME, ".ssh/config");
    const existing = fs.existsSync(sshFile) ? fs.readFileSync(sshFile, "utf8") : "";
    if (!existing.includes(`Host openshell-${sandboxName}`)) {
      fs.mkdirSync(path.join(HOME, ".ssh"), { recursive: true, mode: 0o700 });
      fs.appendFileSync(sshFile, "\n" + sshEntry + "\n");
    }
  } catch { /* ssh-config is optional; connect may still work */ }

  // Upload plugin dir into sandbox
  run(`openshell sandbox upload ${sandboxName} "${PLUGIN_DIR}" /sandbox/.openclaw/extensions/sinain-hud`);
  console.log("  ✓ Plugin uploaded to sandbox");

  // Upload sinain-sources dir into sandbox
  run(`openshell sandbox upload ${sandboxName} "${SOURCES_DIR}" /sandbox/.openclaw/sinain-sources`);
  console.log("  ✓ sinain-sources uploaded to sandbox");

  // Download sandbox openclaw.json, patch, re-upload
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "sinain-oc-"));
  run(`openshell sandbox download ${sandboxName} /sandbox/.openclaw/openclaw.json "${tmpDir}"`);
  const tmpJson = path.join(tmpDir, "openclaw.json");

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(tmpJson, "utf8")); } catch {}

  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.allow   ??= [];
  cfg.plugins.entries["sinain-hud"] = {
    enabled: true,
    config: {
      heartbeatPath: "/sandbox/.openclaw/sinain-sources/HEARTBEAT.md",
      skillPath:     "/sandbox/.openclaw/sinain-sources/SKILL.md",
      memoryPath:    "/sandbox/.openclaw/sinain-sources/sinain-memory",
      sessionKey:    "agent:main:sinain"
    }
  };
  // Remove stale "sinain" entry if present from a previous install
  delete cfg.plugins.entries["sinain"];
  if (!cfg.plugins.allow.includes("sinain-hud")) cfg.plugins.allow.push("sinain-hud");
  cfg.agents                                         ??= {};
  cfg.agents.defaults                                ??= {};
  cfg.agents.defaults.sandbox                        ??= {};
  cfg.agents.defaults.sandbox.sessionToolsVisibility  = "all";
  // NemoClaw: gateway bind/auth are managed by OpenShell — but compaction must be set explicitly
  cfg.agents.defaults.compaction = { mode: "safeguard", maxHistoryShare: 0.2, reserveTokensFloor: 40000 };

  const token = cfg.gateway?.auth?.token ?? "(see sandbox openclaw.json)";

  const jsonContent = JSON.stringify(cfg, null, 2);
  // openshell upload always treats destination as a directory, so use SSH to write the file directly
  const encoded = Buffer.from(jsonContent).toString("base64");
  run(`ssh -T openshell-${sandboxName} "printf '%s' '${encoded}' | base64 --decode > /sandbox/.openclaw/openclaw.json"`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("  ✓ openclaw.json patched in sandbox");

  // Memory restore from backup repo (workspace lives inside sandbox)
  const backupUrl = process.env.SINAIN_BACKUP_REPO;
  if (backupUrl) {
    try {
      await checkRepoPrivacy(backupUrl);
      run(`ssh -T openshell-${sandboxName} 'if [ ! -d /sandbox/.openclaw/workspace/.git ]; then git clone "${backupUrl}" /sandbox/.openclaw/workspace --quiet; fi'`);
      console.log("  ✓ Memory restored from", backupUrl);
    } catch (e) {
      console.error("\n  ✗ Memory restore aborted:", e.message, "\n");
      process.exit(1);
    }
  }

  // Knowledge snapshot repo (optional) — inside sandbox
  const snapshotUrl = process.env.SINAIN_SNAPSHOT_REPO;
  if (snapshotUrl) {
    try {
      await checkRepoPrivacy(snapshotUrl);
      run(`ssh -T openshell-${sandboxName} 'mkdir -p ~/.sinain/knowledge-snapshots && cd ~/.sinain/knowledge-snapshots && ([ -d .git ] || (git init && git config user.name sinain-knowledge && git config user.email sinain@local)) && (git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "${snapshotUrl}" || git remote add origin "${snapshotUrl}") && (git fetch origin && git checkout -B main origin/main) 2>/dev/null || true'`);
      console.log("  ✓ Snapshot repo configured in sandbox");
    } catch (e) {
      console.error("\n  ✗ Snapshot repo setup aborted:", e.message, "\n");
      process.exit(1);
    }
  }

  // Restart openclaw gateway inside sandbox (kill existing PID + start fresh)
  try {
    // Find the gateway PID, kill it, then start a new instance detached
    run_capture(`ssh -T openshell-${sandboxName} 'pid=$(ss -tlnp 2>/dev/null | awk -F"pid=" "/18789/{print \\$2}" | cut -d, -f1); [ -n "$pid" ] && kill "$pid"; nohup openclaw gateway > /tmp/oc-gateway.log 2>&1 &'`);
    console.log("  ✓ Gateway restarted");
  } catch {
    console.warn("  ⚠ Could not restart gateway — it will pick up changes on next start");
  }

  // Forward sandbox port 18789 → VM (idempotent — safe to re-run)
  try {
    run(`openshell forward start --background 18789 ${sandboxName}`);
    console.log("  ✓ Port 18789 forwarded (sandbox → VM)");
  } catch {
    console.warn("  ⚠ Port forward may already be running — check: openshell forward list");
  }

  const vmIp = (() => {
    try { return run_capture("curl -s ifconfig.me 2>/dev/null"); } catch {}
    try { return run_capture("hostname -I | awk '{print $1}'"); } catch {}
    return "YOUR-BREV-IP";
  })();

  console.log(`
✓ sinain installed successfully.
  Sandbox:    ${sandboxName}
  Auth token: ${token}

  Next steps:
    1. In your Brev dashboard → "Expose Port(s)" → enter 18789 → TCP
       (This makes the gateway reachable from your Mac — no SSH tunnel needed)
    2. Run ./setup-nemoclaw.sh on your Mac:
       NemoClaw URL:  ws://${vmIp}:18789
       Auth token:    ${token}
`);
}

// ── Standard path: bare-metal OpenClaw (e.g. strato server) ─────────────────

async function installLocal() {
  // Patch openclaw.json
  let cfg = {};
  if (fs.existsSync(OC_JSON)) {
    try { cfg = JSON.parse(fs.readFileSync(OC_JSON, "utf8")); } catch {}
  }
  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries["sinain-hud"] = {
    enabled: true,
    config: {
      heartbeatPath: path.join(SOURCES_DIR, "HEARTBEAT.md"),
      skillPath:     path.join(SOURCES_DIR, "SKILL.md"),
      memoryPath:    memoryDst,
      sessionKey:    "agent:main:sinain"
    }
  };
  // Remove stale "sinain" entry if present from a previous install
  delete cfg.plugins.entries["sinain"];
  cfg.plugins.allow ??= [];
  if (!cfg.plugins.allow.includes("sinain-hud")) cfg.plugins.allow.push("sinain-hud");
  cfg.agents                                         ??= {};
  cfg.agents.defaults                                ??= {};
  cfg.agents.defaults.sandbox                        ??= {};
  cfg.agents.defaults.sandbox.sessionToolsVisibility  = "all";
  cfg.agents.defaults.compaction = { mode: "safeguard", maxHistoryShare: 0.2, reserveTokensFloor: 40000 };
  cfg.gateway     ??= {};
  cfg.gateway.bind  = "lan";  // allow remote Mac to connect

  // Propagate snapshot repo path to plugin config (used for periodic git-backed knowledge backups)
  if (process.env.SINAIN_SNAPSHOT_REPO) {
    cfg.plugins.entries["sinain-hud"].config.snapshotRepoPath = process.env.SINAIN_SNAPSHOT_REPO;
  }

  fs.mkdirSync(path.dirname(OC_JSON), { recursive: true });
  fs.writeFileSync(OC_JSON, JSON.stringify(cfg, null, 2));
  console.log("  ✓ openclaw.json patched");

  // Memory restore from backup repo
  // Set SINAIN_BACKUP_REPO to a private GitHub repo URL to seed the workspace with
  // existing memory (session summaries, playbook, triplestore, identity files).
  // Expected repo structure: memory/, playbook.md, identity/, triplestore.jsonl, SITUATION.md
  // The repo MUST be private — the installer verifies this via GitHub API.
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

  // Knowledge snapshot repo (optional)
  await setupSnapshotRepo();

  // Start / restart gateway
  try {
    execSync("openclaw gateway restart --background", { stdio: "pipe" });
    console.log("  ✓ Gateway restarted");
  } catch {
    try {
      execSync("openclaw gateway start --background", { stdio: "pipe" });
      console.log("  ✓ Gateway started");
    } catch {
      console.warn("  ⚠ Could not start gateway — run: openclaw gateway");
    }
  }

  const token = cfg?.gateway?.auth?.token ?? "(see openclaw.json)";
  console.log("\n✓ sinain installed successfully.");
  console.log("  Plugin config: ~/.openclaw/openclaw.json");
  console.log(`  Auth token:    ${token}`);
  console.log("  Next: run 'openclaw gateway' if not running, or restart to pick up changes.\n");
}

// ── Knowledge snapshot repo setup (shared) ──────────────────────────────────

const SNAPSHOT_DIR = path.join(HOME, ".sinain", "knowledge-snapshots");

async function setupSnapshotRepo() {
  const snapshotUrl = process.env.SINAIN_SNAPSHOT_REPO;
  if (!snapshotUrl) return;

  try {
    await checkRepoPrivacy(snapshotUrl);
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

    if (!fs.existsSync(path.join(SNAPSHOT_DIR, ".git"))) {
      execSync(`git init "${SNAPSHOT_DIR}"`, { stdio: "pipe" });
      execSync(`git -C "${SNAPSHOT_DIR}" config user.name "sinain-knowledge"`, { stdio: "pipe" });
      execSync(`git -C "${SNAPSHOT_DIR}" config user.email "sinain@local"`, { stdio: "pipe" });
    }

    // Set remote (add or update)
    try {
      run_capture(`git -C "${SNAPSHOT_DIR}" remote get-url origin`);
      execSync(`git -C "${SNAPSHOT_DIR}" remote set-url origin "${snapshotUrl}"`, { stdio: "pipe" });
    } catch {
      execSync(`git -C "${SNAPSHOT_DIR}" remote add origin "${snapshotUrl}"`, { stdio: "pipe" });
    }

    // Pull existing snapshots if remote has content
    try {
      execSync(`git -C "${SNAPSHOT_DIR}" fetch origin`, { stdio: "pipe", timeout: 15_000 });
      execSync(`git -C "${SNAPSHOT_DIR}" checkout -B main origin/main`, { stdio: "pipe" });
      console.log("  ✓ Snapshot repo restored from", snapshotUrl);
    } catch {
      console.log("  ✓ Snapshot repo configured (empty remote)");
    }
  } catch (e) {
    if (e.message?.startsWith("SECURITY") || e.message?.startsWith("Refusing")) {
      console.error("\n  ✗ Snapshot repo setup aborted:", e.message, "\n");
      process.exit(1);
    }
    console.warn("  ⚠ Snapshot repo setup failed:", e.message);
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

function detectNemoClaw() {
  // NemoClaw writes ~/.nemoclaw/sandboxes.json with a defaultSandbox field
  const sandboxesJson = path.join(HOME, ".nemoclaw/sandboxes.json");
  if (!fs.existsSync(sandboxesJson)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sandboxesJson, "utf8"));
    const sandboxName = data.defaultSandbox;
    if (!sandboxName || !data.sandboxes?.[sandboxName]) return null;
    // Verify openshell CLI is reachable
    try { execSync("which openshell", { stdio: "pipe" }); } catch { return null; }
    return { sandboxName };
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: HOME });
}

function run_capture(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], cwd: HOME }).trim();
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
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
  // 404 = private repo (unauthenticated can't see it) — OK
}
