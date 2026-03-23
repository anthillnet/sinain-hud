#!/usr/bin/env node
import { execSync } from "child_process";
import net from "net";
import os from "os";
import fs from "fs";
import path from "path";

const cmd = process.argv[2];
const IS_WINDOWS = os.platform() === "win32";

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

  case "setup":
    await runSetupWizard();
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

// ── Setup wizard (standalone) ─────────────────────────────────────────────────

async function runSetupWizard() {
  // Force-run the wizard even if .env exists (re-configure)
  const { setupWizard } = await import("./launcher.js?setup-only");
  // The wizard is embedded in launcher.js; we import the module dynamically.
  // Since launcher.js runs main() on import, we instead inline a lightweight version.

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const HOME = os.homedir();
  const SINAIN_DIR = path.join(HOME, ".sinain");
  const envPath = path.join(SINAIN_DIR, ".env");

  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";
  const IS_WIN = os.platform() === "win32";

  const cmdExists = (cmd) => {
    try { import("child_process").then(cp => cp.execSync(`which ${cmd}`, { stdio: "pipe" })); return true; }
    catch { return false; }
  };
  // Synchronous version
  const { execSync } = await import("child_process");
  const cmdExistsSync = (cmd) => {
    try { execSync(`which ${cmd}`, { stdio: "pipe" }); return true; }
    catch { return false; }
  };

  if (fs.existsSync(envPath)) {
    const overwrite = await ask(`  ${envPath} already exists. Overwrite? [y/N]: `);
    if (overwrite.trim().toLowerCase() !== "y") {
      console.log("  Aborted.");
      rl.close();
      return;
    }
  }

  console.log();
  console.log(`${BOLD}── Sinain Setup Wizard ─────────────────${RESET}`);
  console.log(`  Configuring ${DIM}~/.sinain/.env${RESET}`);
  console.log();

  const vars = {};

  // Transcription backend
  let transcriptionBackend = "openrouter";
  const hasWhisper = !IS_WIN && cmdExistsSync("whisper-cli");

  if (IS_WIN) {
    console.log(`  ${DIM}(Local whisper not available on Windows — using OpenRouter)${RESET}`);
  } else if (hasWhisper) {
    const choice = await ask(`  Transcription backend? [${BOLD}local${RESET}/cloud]: `);
    transcriptionBackend = choice.trim().toLowerCase() === "cloud" ? "openrouter" : "local";
  } else {
    const install = await ask(`  whisper-cli not found. Install via Homebrew? [Y/n]: `);
    if (!install.trim() || install.trim().toLowerCase() === "y") {
      try {
        execSync("brew install whisper-cpp", { stdio: "inherit" });
        const modelDir = path.join(HOME, "models");
        const modelPath = path.join(modelDir, "ggml-large-v3-turbo.bin");
        if (!fs.existsSync(modelPath)) {
          console.log(`  ${DIM}Downloading model (~1.5 GB)...${RESET}`);
          fs.mkdirSync(modelDir, { recursive: true });
          execSync(`curl -L --progress-bar -o "${modelPath}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"`, { stdio: "inherit" });
        }
        transcriptionBackend = "local";
        vars.LOCAL_WHISPER_MODEL = modelPath;
      } catch {
        console.log(`  ${YELLOW}Install failed — falling back to OpenRouter${RESET}`);
      }
    }
  }
  vars.TRANSCRIPTION_BACKEND = transcriptionBackend;

  // API key
  if (transcriptionBackend === "openrouter") {
    const key = await ask(`  OpenRouter API key (sk-or-...): `);
    if (key.trim()) vars.OPENROUTER_API_KEY = key.trim();
  } else {
    const key = await ask(`  OpenRouter API key for vision/OCR (optional): `);
    if (key.trim()) vars.OPENROUTER_API_KEY = key.trim();
  }

  // Agent
  const agent = await ask(`  Agent? [${BOLD}claude${RESET}/codex/goose/junie/aider]: `);
  vars.SINAIN_AGENT = agent.trim().toLowerCase() || "claude";

  // Escalation
  console.log(`\n  ${DIM}Escalation: off | selective | focus | rich${RESET}`);
  const esc = await ask(`  Escalation mode? [${BOLD}selective${RESET}]: `);
  vars.ESCALATION_MODE = esc.trim().toLowerCase() || "selective";

  // Gateway
  const gw = await ask(`  OpenClaw gateway? [y/N]: `);
  if (gw.trim().toLowerCase() === "y") {
    const url = await ask(`  Gateway WS URL [ws://localhost:18789]: `);
    vars.OPENCLAW_WS_URL = url.trim() || "ws://localhost:18789";
    const token = await ask(`  Auth token (48-char hex): `);
    if (token.trim()) {
      vars.OPENCLAW_WS_TOKEN = token.trim();
      vars.OPENCLAW_HTTP_TOKEN = token.trim();
    }
    vars.OPENCLAW_HTTP_URL = vars.OPENCLAW_WS_URL.replace(/^ws/, "http") + "/hooks/agent";
    vars.OPENCLAW_SESSION_KEY = "agent:main:sinain";
  } else {
    // No gateway — disable WS connection attempts
    vars.OPENCLAW_WS_URL = "";
    vars.OPENCLAW_HTTP_URL = "";
  }

  vars.SINAIN_POLL_INTERVAL = "5";
  vars.SINAIN_HEARTBEAT_INTERVAL = "900";
  vars.PRIVACY_MODE = "standard";

  // Write — start from .env.example template, patch wizard values in
  fs.mkdirSync(SINAIN_DIR, { recursive: true });

  const PKG_DIR = path.dirname(new URL(import.meta.url).pathname);
  const examplePath = path.join(PKG_DIR, ".env.example");
  const siblingExample = path.join(PKG_DIR, "..", ".env.example");
  let template = "";
  if (fs.existsSync(examplePath)) {
    template = fs.readFileSync(examplePath, "utf-8");
  } else if (fs.existsSync(siblingExample)) {
    template = fs.readFileSync(siblingExample, "utf-8");
  }

  if (template) {
    for (const [k, v] of Object.entries(vars)) {
      const regex = new RegExp(`^#?\\s*${k}=.*$`, "m");
      if (regex.test(template)) {
        template = template.replace(regex, `${k}=${v}`);
      } else {
        template += `\n${k}=${v}`;
      }
    }
    template = `# Generated by sinain setup wizard — ${new Date().toISOString()}\n${template}`;
    fs.writeFileSync(envPath, template);
  } else {
    const lines = ["# sinain configuration — generated by setup wizard", `# ${new Date().toISOString()}`, ""];
    for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${v}`);
    lines.push("");
    fs.writeFileSync(envPath, lines.join("\n"));
  }

  rl.close();
  console.log(`\n  ${GREEN}✓${RESET} Config written to ${envPath}\n`);
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

  // Overlay
  const overlayUp = isProcessRunning("sinain_hud");
  if (overlayUp) {
    console.log(`  ${MAGENTA}overlay${RESET}          ${GREEN}✓${RESET}  running`);
  } else {
    console.log(`  ${MAGENTA}overlay${RESET}          ${DIM}—  stopped${RESET}`);
  }

  // Agent
  const agentUp = isProcessRunning("sinain-agent");
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

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
sinain — AI overlay system for macOS and Windows

Usage:
  sinain start [options]       Launch sinain services
  sinain stop                  Stop all sinain services
  sinain status                Check what's running
  sinain setup                 Run interactive setup wizard (~/.sinain/.env)
  sinain setup-overlay         Download pre-built overlay app
  sinain setup-sck-capture     Download sck-capture audio binary (macOS)
  sinain install               Install OpenClaw plugin (server-side)

Start options:
  --no-sense                   Skip screen capture (sense_client)
  --no-overlay                 Skip overlay
  --no-agent                   Skip agent poll loop
  --agent=<name>               Agent to use: claude, codex, goose, aider (default: claude)

Setup-overlay options:
  --from-source                Build from Flutter source instead of downloading
  --update                     Force re-download even if version matches
`);

}
