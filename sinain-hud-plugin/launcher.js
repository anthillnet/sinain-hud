#!/usr/bin/env node
// sinain launcher — process orchestrator for `sinain start`
// Ports the logic from start.sh + sinain-agent/run.sh into a single Node.js process manager.

import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import readline from "readline";

// ── Colors ──────────────────────────────────────────────────────────────────

const CYAN    = "\x1b[36m";
const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED     = "\x1b[31m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";
const RESET   = "\x1b[0m";

// ── Resolve paths ───────────────────────────────────────────────────────────

const PKG_DIR = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const PID_FILE = "/tmp/sinain-pids.txt";

// ── Parse flags ─────────────────────────────────────────────────────────────

const args = process.argv.slice(3); // skip node, cli.js, "start"
let skipSense = false;
let skipOverlay = false;
let skipAgent = false;
let agentName = null;

for (const arg of args) {
  if (arg === "--no-sense")   { skipSense = true; continue; }
  if (arg === "--no-overlay") { skipOverlay = true; continue; }
  if (arg === "--no-agent")   { skipAgent = true; continue; }
  if (arg.startsWith("--agent=")) { agentName = arg.split("=")[1]; continue; }
  console.error(`Unknown flag: ${arg}`);
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────────────

const children = [];    // { name, proc, pid }

// ── Main ────────────────────────────────────────────────────────────────────

await main();

async function main() {
  setupSignalHandlers();

  log("Preflight checks...");
  await preflight();
  console.log();

  // Load user config
  loadUserEnv();

  // Auto-detect transcription backend
  detectTranscription();

  // Kill stale processes
  killStale();

  // Install deps if needed
  await installDeps();

  // Start core
  log("Starting sinain-core...");
  const coreDir = path.join(PKG_DIR, "sinain-core");
  const tsxBin = path.join(coreDir, "node_modules/.bin/tsx");
  const coreEntry = path.join(coreDir, "src/index.ts");

  // Pass .env vars to core (it also loads its own .env, but user config should override)
  startProcess("core", tsxBin, ["watch", coreEntry], {
    cwd: coreDir,
    color: CYAN,
  });

  // Health check
  const healthy = await healthCheck("http://localhost:9500/health", 20);
  if (!healthy) {
    fail("sinain-core did not become healthy after 20s");
  }
  ok("sinain-core healthy on :9500");

  // Start sense_client
  let senseStatus = "skipped";
  if (!skipSense) {
    const hasPython = commandExists("python3");
    if (hasPython) {
      // Install sense deps if needed
      const reqFile = path.join(PKG_DIR, "sense_client/requirements.txt");
      if (fs.existsSync(reqFile)) {
        const scDir = path.join(PKG_DIR, "sense_client");
        // Check if key package is importable to skip pip
        try {
          execSync('python3 -c "import cv2; import skimage"', { stdio: "pipe" });
        } catch {
          log("Installing sense_client Python dependencies...");
          try {
            execSync(`pip3 install -r "${reqFile}" --quiet --break-system-packages`, { stdio: "inherit" });
          } catch {
            try {
              execSync(`pip3 install -r "${reqFile}" --quiet`, { stdio: "inherit" });
            } catch {
              warn("pip3 install failed — sense_client may not work");
            }
          }
        }
      }

      log("Starting sense_client...");
      startProcess("sense", "python3", ["-m", "sense_client"], {
        cwd: PKG_DIR,
        color: YELLOW,
      });
      // Give it a moment to fail fast if misconfigured
      await sleep(1000);
      const senseChild = children.find(c => c.name === "sense");
      if (senseChild && !senseChild.proc.killed && senseChild.proc.exitCode === null) {
        ok(`sense_client running (pid:${senseChild.pid})`);
        senseStatus = "running";
      } else {
        warn("sense_client exited early — check logs above");
        senseStatus = "failed";
      }
    } else {
      warn("python3 not found — sense_client skipped");
    }
  }

  // Start overlay
  let overlayStatus = "skipped";
  if (!skipOverlay) {
    const overlayDir = findOverlayDir();
    const hasFlutter = commandExists("flutter");
    if (overlayDir && hasFlutter) {
      log("Starting overlay...");
      startProcess("overlay", "flutter", ["run", "-d", "macos"], {
        cwd: overlayDir,
        color: MAGENTA,
      });
      await sleep(2000);
      const overlayChild = children.find(c => c.name === "overlay");
      if (overlayChild && !overlayChild.proc.killed && overlayChild.proc.exitCode === null) {
        ok(`overlay running (pid:${overlayChild.pid})`);
        overlayStatus = "running";
      } else {
        warn("overlay exited early — check logs above");
        overlayStatus = "failed";
      }
    } else if (!overlayDir) {
      warn("overlay not found — run: sinain setup-overlay");
    } else {
      warn("flutter not found — overlay skipped");
    }
  }

  // Start agent
  let agentStatus = "skipped";
  if (!skipAgent) {
    const runSh = path.join(PKG_DIR, "sinain-agent/run.sh");
    if (fs.existsSync(runSh)) {
      // Generate MCP config with absolute paths
      const mcpConfigPath = generateMcpConfig();

      // Resolve agent name
      const agent = agentName || process.env.SINAIN_AGENT || "claude";

      log(`Starting agent (${agent})...`);
      startProcess("agent", "bash", [runSh], {
        cwd: path.join(PKG_DIR, "sinain-agent"),
        color: GREEN,
        extraEnv: {
          MCP_CONFIG: mcpConfigPath,
          SINAIN_AGENT: agent,
        },
      });
      await sleep(2000);
      const agentChild = children.find(c => c.name === "agent");
      if (agentChild && !agentChild.proc.killed && agentChild.proc.exitCode === null) {
        ok(`agent running (pid:${agentChild.pid})`);
        agentStatus = "running";
      } else {
        warn("agent exited early — check logs above");
        agentStatus = "failed";
      }
    } else {
      warn("sinain-agent/run.sh not found — agent skipped");
    }
  }

  // Write PID file
  writePidFile();

  // Banner
  printBanner({ senseStatus, overlayStatus, agentStatus });

  // Wait forever (children keep us alive)
  await new Promise(() => {});
}

// ── Preflight ───────────────────────────────────────────────────────────────

async function preflight() {
  // Node version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1));
  if (major < 18) {
    fail(`Node.js >= 18 required (found ${nodeVer})`);
  }
  ok(`node ${nodeVer}`);

  // Python
  if (commandExists("python3")) {
    const pyVer = execSync("python3 --version 2>&1", { encoding: "utf-8" }).trim().split(" ")[1];
    ok(`python3 ${pyVer}`);
  } else {
    warn("python3 not found — sense_client will be skipped");
    skipSense = true;
  }

  // Flutter (optional)
  if (commandExists("flutter")) {
    try {
      const flutterVer = execSync("flutter --version 2>&1", { encoding: "utf-8" }).split("\n")[0].split(" ")[1];
      ok(`flutter ${flutterVer}`);
    } catch {
      ok("flutter (version unknown)");
    }
  } else {
    warn("flutter not found — overlay will be skipped");
    skipOverlay = true;
  }

  // Port 9500
  const portFree = await isPortFree(9500);
  if (!portFree) {
    // Will be freed by killStale
    warn("port 9500 in use — will attempt to free");
  } else {
    ok("port 9500 free");
  }
}

// ── User environment ────────────────────────────────────────────────────────

function loadUserEnv() {
  const envPaths = [
    path.join(SINAIN_DIR, ".env"),
    path.join(PKG_DIR, "sinain-core/.env"),
  ];

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      // Don't override existing env vars
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }

  // Ensure ~/.sinain directory exists
  fs.mkdirSync(SINAIN_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".sinain/capture"), { recursive: true });

  // Check for API key
  if (!process.env.OPENROUTER_API_KEY) {
    warn("OPENROUTER_API_KEY not set");
    console.log(`  Set it in ${path.join(SINAIN_DIR, ".env")}:`);
    console.log(`    OPENROUTER_API_KEY=sk-or-...`);
    console.log();
  }
}

// ── Transcription auto-detect ───────────────────────────────────────────────

function detectTranscription() {
  if (process.env.TRANSCRIPTION_BACKEND) return;

  // Check for whisper-cli (local transcription)
  if (commandExists("whisper-cli")) {
    process.env.TRANSCRIPTION_BACKEND = "local";
    ok("transcription: local (whisper-cli)");

    // Try to find model path
    if (!process.env.WHISPER_MODEL_PATH) {
      const defaultModel = path.join(HOME, ".cache/whisper/ggml-base.en.bin");
      if (fs.existsSync(defaultModel)) {
        process.env.WHISPER_MODEL_PATH = defaultModel;
      }
    }
    return;
  }

  // Fallback: OpenRouter API
  if (process.env.OPENROUTER_API_KEY) {
    process.env.TRANSCRIPTION_BACKEND = "openrouter";
    ok("transcription: openrouter (API)");
    return;
  }

  warn("No transcription backend detected");
  console.log("  Option 1: Install whisper-cli for local transcription");
  console.log("  Option 2: Set OPENROUTER_API_KEY for cloud transcription");
  console.log();
}

// ── Install dependencies ────────────────────────────────────────────────────

async function installDeps() {
  const coreDir = path.join(PKG_DIR, "sinain-core");
  if (!fs.existsSync(path.join(coreDir, "node_modules"))) {
    log("Installing sinain-core dependencies...");
    execSync("npm install --production", { cwd: coreDir, stdio: "inherit" });
    ok("sinain-core dependencies installed");
  } else {
    ok("sinain-core/node_modules present");
  }

  const mcpDir = path.join(PKG_DIR, "sinain-mcp-server");
  if (fs.existsSync(mcpDir) && !fs.existsSync(path.join(mcpDir, "node_modules"))) {
    log("Installing sinain-mcp-server dependencies...");
    execSync("npm install --production", { cwd: mcpDir, stdio: "inherit" });
    ok("sinain-mcp-server dependencies installed");
  }
}

// ── Kill stale processes ────────────────────────────────────────────────────

function killStale() {
  let killed = false;
  const patterns = [
    "sinain_hud.app/Contents/MacOS/sinain_hud",
    "flutter run -d macos",
    "python3 -m sense_client",
    "Python -m sense_client",
    "tsx.*src/index.ts",
    "tsx watch src/index.ts",
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
  } catch { /* already free */ }

  // Clean old PID file
  if (fs.existsSync(PID_FILE)) {
    try {
      const lines = fs.readFileSync(PID_FILE, "utf-8").split("\n");
      for (const line of lines) {
        const pid = line.split("=")[1]?.trim();
        if (pid) {
          try { process.kill(parseInt(pid), "SIGTERM"); killed = true; } catch { /* gone */ }
        }
      }
    } catch { /* ignore */ }
    fs.unlinkSync(PID_FILE);
  }

  if (killed) {
    warn("killed stale processes from previous run");
    // Brief pause for ports to free
    execSync("sleep 1", { stdio: "pipe" });
  }
}

// ── Process management ──────────────────────────────────────────────────────

function startProcess(name, command, args, { cwd, color, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };

  const proc = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `${color}[${name}]${RESET}`.padEnd(22); // account for ANSI codes

  // Pipe stdout with prefix
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      process.stdout.write(`${prefix} ${line}\n`);
    });
  }

  // Pipe stderr with prefix
  if (proc.stderr) {
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      process.stderr.write(`${prefix} ${line}\n`);
    });
  }

  proc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`${prefix} exited with code ${code}`);
    }
  });

  children.push({ name, proc, pid: proc.pid });
  return proc;
}

// ── MCP config generation ───────────────────────────────────────────────────

function generateMcpConfig() {
  const coreDir = path.join(PKG_DIR, "sinain-core");
  const tsxBin = path.join(coreDir, "node_modules/.bin/tsx");
  const mcpEntry = path.join(PKG_DIR, "sinain-mcp-server/index.ts");
  const workspace = process.env.SINAIN_WORKSPACE || path.join(HOME, ".openclaw/workspace");

  const config = {
    mcpServers: {
      sinain: {
        command: tsxBin,
        args: [mcpEntry],
        env: {
          SINAIN_CORE_URL: process.env.SINAIN_CORE_URL || "http://localhost:9500",
          SINAIN_WORKSPACE: workspace,
        },
      },
    },
  };

  const tmpDir = path.join(SINAIN_DIR, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, "mcp-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ── Overlay discovery ───────────────────────────────────────────────────────

function findOverlayDir() {
  // 1. Sibling overlay/ (running from cloned repo)
  const siblingOverlay = path.join(PKG_DIR, "..", "overlay");
  if (fs.existsSync(path.join(siblingOverlay, "pubspec.yaml"))) {
    return siblingOverlay;
  }

  // 2. ~/.sinain/overlay/ (installed via setup-overlay)
  const installedOverlay = path.join(SINAIN_DIR, "overlay");
  if (fs.existsSync(path.join(installedOverlay, "pubspec.yaml"))) {
    return installedOverlay;
  }

  return null;
}

// ── Health check ────────────────────────────────────────────────────────────

async function healthCheck(url, retries) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(1000);
  }
  return false;
}

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner({ senseStatus, overlayStatus, agentStatus }) {
  console.log();
  console.log(`${BOLD}── SinainHUD ──────────────────────────${RESET}`);

  // Core (always running if we got here)
  console.log(`  ${CYAN}core${RESET}     :9500   ${GREEN}✓${RESET}  (http+ws)`);

  // Sense
  printServiceLine("sense", YELLOW, senseStatus);

  // Overlay
  printServiceLine("overlay", MAGENTA, overlayStatus);

  // Agent
  printServiceLine("agent", GREEN, agentStatus);

  console.log(`${BOLD}───────────────────────────────────────${RESET}`);
  console.log(`  Press ${BOLD}Ctrl+C${RESET} to stop all services`);
  console.log(`${BOLD}───────────────────────────────────────${RESET}`);
  console.log();
}

function printServiceLine(name, color, status) {
  const padded = name.padEnd(8);
  switch (status) {
    case "running":
      console.log(`  ${color}${padded}${RESET}         ${GREEN}✓${RESET}  running`);
      break;
    case "failed":
      console.log(`  ${color}${padded}${RESET}         ${RED}✗${RESET}  failed`);
      break;
    case "skipped":
    default:
      console.log(`  ${color}${padded}${RESET}         ${DIM}—  skipped${RESET}`);
      break;
  }
}

// ── PID file ────────────────────────────────────────────────────────────────

function writePidFile() {
  const lines = children.map(c => `${c.name}=${c.pid}`).join("\n");
  fs.writeFileSync(PID_FILE, lines + "\n");
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function setupSignalHandlers() {
  let cleaning = false;

  const cleanup = (signal) => {
    if (cleaning) return;
    cleaning = true;
    console.log(`\n${BOLD}[start]${RESET} Shutting down services...`);

    // SIGTERM all children
    for (const { proc, name } of children) {
      try {
        if (!proc.killed) proc.kill("SIGTERM");
      } catch { /* already gone */ }
    }

    // Force kill after 2s
    setTimeout(() => {
      for (const { proc } of children) {
        try {
          if (!proc.killed) proc.kill("SIGKILL");
        } catch { /* already gone */ }
      }
      // Clean up port
      try {
        execSync("lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null", { stdio: "pipe" });
      } catch { /* ok */ }

      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      console.log(`${BOLD}[start]${RESET} All services stopped.`);
      process.exit(0);
    }, 2000);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`${BOLD}[start]${RESET} ${msg}`);
}

function ok(msg) {
  console.log(`${BOLD}[start]${RESET} ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg) {
  console.log(`${BOLD}[start]${RESET} ${YELLOW}⚠${RESET} ${msg}`);
}

function fail(msg) {
  console.error(`${BOLD}[start]${RESET} ${RED}✗${RESET} ${msg}`);
  // Kill any started children before exiting
  for (const { proc } of children) {
    try { if (!proc.killed) proc.kill("SIGKILL"); } catch { /* ok */ }
  }
  process.exit(1);
}
