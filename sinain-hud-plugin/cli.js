#!/usr/bin/env node
import { execSync } from "child_process";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";

const cmd = process.argv[2];

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

  case "setup-overlay":
    await import("./setup-overlay.js");
    break;

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

  default:
    printUsage();
    break;
}

// ── Stop ──────────────────────────────────────────────────────────────────────

async function stopServices() {
  let killed = false;

  const patterns = [
    "tsx.*src/index.ts",
    "tsx watch src/index.ts",
    "python3 -m sense_client",
    "Python -m sense_client",
    "flutter run -d macos",
    "sinain_hud.app/Contents/MacOS/sinain_hud",
    "sinain-agent/run.sh",
  ];

  for (const pat of patterns) {
    try {
      execSync(`pkill -f "${pat}"`, { stdio: "pipe" });
      killed = true;
    } catch { /* not running */ }
  }

  // Free port 9500
  try {
    const pid = execSync("lsof -i :9500 -sTCP:LISTEN -t", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (pid) {
      execSync(`kill ${pid}`, { stdio: "pipe" });
      killed = true;
    }
  } catch { /* port already free */ }

  // Clean PID file
  const pidFile = "/tmp/sinain-pids.txt";
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

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

  // Sense: check pgrep
  const senseUp = isProcessRunning("python3 -m sense_client") || isProcessRunning("Python -m sense_client");
  if (senseUp) {
    console.log(`  ${YELLOW}sense${RESET}            ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${YELLOW}sense${RESET}            ${DIM}—  stopped${RESET}`);
  }

  // Overlay
  const overlayUp = isProcessRunning("sinain_hud.app") || isProcessRunning("flutter run -d macos");
  if (overlayUp) {
    console.log(`  ${MAGENTA}overlay${RESET}          ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${MAGENTA}overlay${RESET}          ${DIM}—  stopped${RESET}`);
  }

  // Agent
  const agentUp = isProcessRunning("sinain-agent/run.sh");
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
    execSync(`pgrep -f "${pattern}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
sinain — AI overlay system for macOS

Usage:
  sinain start [options]       Launch sinain services
  sinain stop                  Stop all sinain services
  sinain status                Check what's running
  sinain setup-overlay         Clone and build the overlay app
  sinain install               Install OpenClaw plugin (server-side)

Start options:
  --no-sense                   Skip screen capture (sense_client)
  --no-overlay                 Skip Flutter overlay
  --no-agent                   Skip agent poll loop
  --agent=<name>               Agent to use: claude, codex, goose, aider (default: claude)
`);
}
