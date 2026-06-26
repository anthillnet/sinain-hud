#!/usr/bin/env node
import { execSync } from "child_process";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";
import { checkForUpdate } from "./self-update.js";
import { detach as detachEncryptedStore } from "./encrypted-store.js";

const cmd = process.argv[2];
const IS_WINDOWS = os.platform() === "win32";
const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const PKG_DIR = path.dirname(new URL(import.meta.url).pathname);

// Self-update sentinel — query the npm registry, and if a newer version
// of @geravant/sinain is available, re-exec before doing anything else.
// Adds ~500ms startup but kills the "stale npx cache silently serves 1.6.x"
// class of bugs permanently. See self-update.js for details + opt-out env var.
//
// Wrapped in try/catch so a bug here (or a missing module) can't silently
// kill the CLI — the user always sees the dispatch path run, even if the
// update check fails for any reason.
try {
  await checkForUpdate();
} catch (err) {
  process.stderr.write(`  ⚠ self-update check failed: ${err.message}\n  (continuing with installed version)\n`);
}

switch (cmd) {
  case "start":
    await import("./launcher.js");
    break;

  case "stop":
    await stopServices();
    break;

  case "status":
    await showStatus();
    break;

  case "onboard":
    await import("./onboard.js");
    break;

  case "config":
    await import("./config.js");
    break;

  case "setup":
    // Legacy — redirect to onboard
    console.log("\x1b[33m  ⚠ `sinain setup` is deprecated. Use: sinain onboard\x1b[0m");
    console.log("\x1b[2m    Or: sinain onboard --advanced for full options\x1b[0m\n");
    await import("./onboard.js");
    break;

  case "setup-overlay":
    await import("./setup-overlay.js");
    break;

  case "setup-sck-capture": {
    const { downloadBinary } = await import("./setup-sck-capture.js");
    if (os.platform() === "win32") {
      console.log("sck-capture is macOS-only (Windows uses win-audio-capture.exe)");
    } else {
      const forceUpdate = process.argv.includes("--update");
      await downloadBinary({ forceUpdate });
    }
    break;
  }

  case "setup-embedding": {
    const { cacheEmbeddingModel } = await import("./setup-embedding.js");
    const forceUpdate = process.argv.includes("--update");
    await cacheEmbeddingModel({ forceUpdate });
    break;
  }

  case "install":
    // --if-openclaw: only run if OpenClaw is installed (for postinstall)
    if (process.argv.includes("--if-openclaw")) {
      const ocJson = path.join(os.homedir(), ".openclaw/openclaw.json");
      if (!fs.existsSync(ocJson)) {
        console.log("  OpenClaw not detected — skipping plugin install");
        process.exit(0);
      }
    }
    await import("./install.js");
    break;

  case "mcp": {
    const sub = process.argv[3]; // install | list | remove
    const { runMcpCli } = await import("./mcp-register.js");
    await runMcpCli(sub, process.argv.slice(4));
    break;
  }

  case "wipe":
    await import("./wipe-data.js");
    break;

  case "export-knowledge":
    await exportKnowledge();
    break;

  case "import-knowledge":
    await importKnowledge();
    break;

  default:
    printUsage();
    break;
}

// ── Stop ──────────────────────────────────────────────────────────────────────

async function stopServices() {
  let killed = false;

  if (IS_WINDOWS) {
    const exes = ["sinain_hud.exe", "tsx.cmd", "python3.exe", "python.exe"];
    for (const exe of exes) {
      try {
        execSync(`taskkill /F /IM "${exe}" 2>NUL`, { stdio: "pipe" });
        killed = true;
      } catch { /* not running */ }
    }
  } else {
    const patterns = [
      "tsx.*src/index.ts",
      "tsx watch src/index.ts",
      "python3 -m sense_client",
      "Python -m sense_client",
      "sinain-chat-agent/sidecar.py",
      "python3 sidecar.py",
      "Python sidecar.py",
      "flutter run -d macos",
      "sinain_hud.app/Contents/MacOS/sinain_hud",
      "sinain-agent-runner/run.sh",
    ];

    for (const pat of patterns) {
      try {
        execSync(`pkill -f "${pat}"`, { stdio: "pipe" });
        killed = true;
      } catch { /* not running */ }
    }
  }

  // Free port 9500
  try {
    if (IS_WINDOWS) {
      const out = execSync('netstat -ano | findstr ":9500" | findstr "LISTENING"', { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const pid = out.split(/\s+/).pop();
      if (pid && pid !== "0") {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
        killed = true;
      }
    } else {
      const pid = execSync("lsof -i :9500 -sTCP:LISTEN -t", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (pid) {
        execSync(`kill ${pid}`, { stdio: "pipe" });
        killed = true;
      }
    }
  } catch { /* port already free */ }

  // Clean PID file
  const pidFile = path.join(os.tmpdir(), "sinain-pids.txt");
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  // Unmount the encrypted store after core is stopped (no-op unless enabled).
  try { detachEncryptedStore(); } catch { /* best-effort */ }

  if (killed) {
    console.log("sinain services stopped.");
  } else {
    console.log("No sinain services were running.");
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

async function showStatus() {
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const MAGENTA = "\x1b[35m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";

  console.log(`\n${BOLD}── SinainHUD Status ────────────────────${RESET}`);

  // Core: check port 9500
  const coreUp = await isPortOpen(9500);
  if (coreUp) {
    console.log(`  ${CYAN}core${RESET}     :9500   ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${CYAN}core${RESET}     :9500   ${RED}✗${RESET}  stopped`);
  }

  // Sense: check process
  const senseUp = isProcessRunning("python3 -m sense_client") || isProcessRunning("Python -m sense_client");
  if (senseUp) {
    console.log(`  ${YELLOW}sense${RESET}            ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${YELLOW}sense${RESET}            ${DIM}—  stopped${RESET}`);
  }

  // Chat sidecar: built-in sinain chat lane on :9610
  const chatUp = await isPortOpen(9610);
  if (chatUp) {
    console.log(`  ${MAGENTA}chat${RESET}     :9610   ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${MAGENTA}chat${RESET}     :9610   ${DIM}—  stopped${RESET}`);
  }

  // Overlay
  const overlayUp = isProcessRunning("sinain_hud");
  if (overlayUp) {
    console.log(`  ${MAGENTA}overlay${RESET}          ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${MAGENTA}overlay${RESET}          ${DIM}—  stopped${RESET}`);
  }

  // Agent
  const agentUp = isProcessRunning("sinain-agent-runner");
  if (agentUp) {
    console.log(`  ${GREEN}agent${RESET}            ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${GREEN}agent${RESET}            ${DIM}—  stopped${RESET}`);
  }

  console.log(`${BOLD}────────────────────────────────────────${RESET}\n`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, "127.0.0.1");
  });
}

function isProcessRunning(pattern) {
  try {
    if (IS_WINDOWS) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${pattern}.exe" 2>NUL`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return out.includes(pattern);
    } else {
      execSync(`pgrep -f "${pattern}"`, { stdio: "pipe" });
      return true;
    }
  } catch {
    return false;
  }
}

// ── Knowledge export/import ──────────────────────────────────────────────────

function findWorkspace() {
  const candidates = [
    process.env.SINAIN_WORKSPACE,
    path.join(HOME, ".openclaw/workspace"),
    path.join(HOME, ".sinain/workspace"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const resolved = dir.replace(/^~/, HOME);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

async function exportKnowledge() {
  const BOLD = "\x1b[1m", GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", RESET = "\x1b[0m";

  const workspace = findWorkspace();
  if (!workspace) {
    console.error(`${RED}✗${RESET} No knowledge workspace found.`);
    console.error(`  Checked: SINAIN_WORKSPACE env, ~/.openclaw/workspace, ~/.sinain/workspace`);
    process.exit(1);
  }

  const outputIdx = process.argv.indexOf("--output");
  const outputPath = outputIdx !== -1 && process.argv[outputIdx + 1]
    ? path.resolve(process.argv[outputIdx + 1])
    : path.join(HOME, "sinain-knowledge-export.tar.gz");

  // Collect files that exist
  const includes = [];
  const check = (rel) => {
    const full = path.join(workspace, rel);
    if (fs.existsSync(full)) { includes.push(rel); return true; }
    return false;
  };

  check("modules");
  check("memory/sinain-playbook.md");
  check("memory/knowledge-graph.db");
  check("memory/playbook-base.md");
  check("memory/playbook.md");
  check("memory/sinain-knowledge.md");

  if (includes.length === 0) {
    console.error(`${RED}✗${RESET} No knowledge files found in ${workspace}`);
    process.exit(1);
  }

  console.log(`${BOLD}[export]${RESET} Exporting from ${DIM}${workspace}${RESET}`);
  for (const inc of includes) {
    console.log(`  ${GREEN}+${RESET} ${inc}`);
  }

  try {
    execSync(
      `tar czf "${outputPath}" --exclude="memory/triplestore.db" ${includes.map(i => `"${i}"`).join(" ")}`,
      { cwd: workspace, stdio: "pipe" }
    );
  } catch (e) {
    console.error(`${RED}✗${RESET} tar failed: ${e.message}`);
    process.exit(1);
  }

  const size = fs.statSync(outputPath).size;
  const sizeStr = size < 1024 * 1024
    ? `${(size / 1024).toFixed(1)} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;

  console.log(`\n${GREEN}✓${RESET} Exported to ${BOLD}${outputPath}${RESET} (${sizeStr})`);
  console.log(`  Transfer to another machine and run: ${BOLD}sinain import-knowledge ${path.basename(outputPath)}${RESET}`);
}

async function importKnowledge() {
  const BOLD = "\x1b[1m", GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";

  const filePath = process.argv[3];
  if (!filePath) {
    console.error(`${RED}✗${RESET} Usage: sinain import-knowledge <file.tar.gz>`);
    process.exit(1);
  }

  const resolved = path.resolve(filePath.replace(/^~/, HOME));
  if (!fs.existsSync(resolved)) {
    console.error(`${RED}✗${RESET} File not found: ${resolved}`);
    process.exit(1);
  }

  const targetWorkspace = path.join(HOME, ".sinain/workspace");
  fs.mkdirSync(targetWorkspace, { recursive: true });

  console.log(`${BOLD}[import]${RESET} Importing to ${DIM}${targetWorkspace}${RESET}`);

  // Extract
  try {
    execSync(`tar xzf "${resolved}" -C "${targetWorkspace}"`, { stdio: "inherit" });
  } catch (e) {
    console.error(`${RED}✗${RESET} Extraction failed: ${e.message}`);
    process.exit(1);
  }

  // Symlink sinain-memory scripts from npm package
  const srcMemory = path.join(PKG_DIR, "sinain-memory");
  const dstMemory = path.join(targetWorkspace, "sinain-memory");
  if (fs.existsSync(srcMemory)) {
    try { fs.rmSync(dstMemory, { recursive: true, force: true }); } catch {}
    fs.symlinkSync(srcMemory, dstMemory, IS_WINDOWS ? "junction" : undefined);
    console.log(`  ${GREEN}✓${RESET} sinain-memory scripts linked`);
  }

  // Update ~/.sinain/.env
  const envPath = path.join(SINAIN_DIR, ".env");
  const envVars = {
    SINAIN_WORKSPACE: targetWorkspace,
    OPENCLAW_WORKSPACE_DIR: targetWorkspace,
  };

  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, "utf-8");
    for (const [key, val] of Object.entries(envVars)) {
      const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
    }
    fs.writeFileSync(envPath, content);
  } else {
    fs.mkdirSync(SINAIN_DIR, { recursive: true });
    const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envPath, lines.join("\n") + "\n");
  }
  console.log(`  ${GREEN}✓${RESET} SINAIN_WORKSPACE set in ${DIM}~/.sinain/.env${RESET}`);

  // Summary
  const items = [];
  if (fs.existsSync(path.join(targetWorkspace, "modules"))) items.push("modules");
  if (fs.existsSync(path.join(targetWorkspace, "memory/sinain-playbook.md"))) items.push("playbook");
  if (fs.existsSync(path.join(targetWorkspace, "memory/knowledge-graph.db"))) items.push("knowledge graph");

  console.log(`\n${GREEN}✓${RESET} Knowledge imported: ${items.join(", ")}`);
  console.log(`  Workspace: ${BOLD}${targetWorkspace}${RESET}`);
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
sinain — AI overlay system for macOS and Windows

Usage:
  sinain onboard               Interactive setup wizard (recommended)
  sinain onboard --advanced    Full setup with privacy, models, gateway options
  sinain onboard --reset       Reset config and start fresh
  sinain start [options]       Launch sinain services
  sinain stop                  Stop all sinain services
  sinain status                Check what's running
  sinain setup                 (deprecated — use onboard)
  sinain setup-overlay         Download pre-built overlay app
  sinain setup-sck-capture     Download sck-capture audio binary (macOS)
  sinain setup-embedding       Pre-cache sentence-transformer model (~90MB)
  sinain export-knowledge      Export knowledge for transfer to another machine
  sinain import-knowledge <file>  Import knowledge from export file
  sinain wipe [--yes]          Erase on-device user data (graph, transcripts, OCR, captures, logs)
                               Preserves config/keys; --include-config removes those too
  sinain install               Install OpenClaw plugin (server-side)
  sinain mcp install           Register sinain MCP for your agents (Claude, Cursor, Codex, Goose, Junie)
  sinain mcp list              Show MCP registration status across agents
  sinain mcp remove <agent>    Unregister sinain MCP from one agent

Start options:
  --no-sense                   Skip screen capture (sense_client)
  --no-overlay                 Skip overlay
  --no-agent                   Skip agent poll loop
  --agent=<name>               Agent to use: claude, codex, goose, aider (default: claude)

Setup-overlay options:
  --from-source                Build from Flutter source instead of downloading
  --update                     Force re-download even if version matches

Setup-embedding options:
  --update                     Force re-download even if model is already cached
`);

}
