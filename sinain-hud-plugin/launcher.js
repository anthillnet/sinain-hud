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
const PID_FILE = path.join(os.tmpdir(), "sinain-pids.txt");
const IS_WINDOWS = os.platform() === "win32";

// ── Parse flags ─────────────────────────────────────────────────────────────

const args = process.argv.slice(3); // skip node, cli.js, "start"
let skipSense = false;
let skipOverlay = false;
let skipAgent = false;
let agentName = null;
let forceSetup = false;

for (const arg of args) {
  if (arg === "--no-sense")   { skipSense = true; continue; }
  if (arg === "--no-overlay") { skipOverlay = true; continue; }
  if (arg === "--no-agent")   { skipAgent = true; continue; }
  if (arg === "--setup")      { forceSetup = true; continue; }
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

  // Run setup wizard on first launch (no ~/.sinain/.env) or when --setup flag is passed
  const userEnvPath = path.join(SINAIN_DIR, ".env");
  if (forceSetup || !fs.existsSync(userEnvPath)) {
    await setupWizard(userEnvPath);
  }

  // Load user config
  loadUserEnv();

  // Ensure Ollama is running (if local vision enabled)
  if (process.env.LOCAL_VISION_ENABLED === "true") {
    await ensureOllama();
  }

  // Auto-detect transcription backend
  detectTranscription();

  // Kill stale processes
  killStale();

  // Install deps if needed
  await installDeps();

  // Auto-download sck-capture binary if missing (macOS only)
  if (!IS_WINDOWS) {
    const sckBinary = path.join(SINAIN_DIR, "sck-capture", "sck-capture");
    if (!fs.existsSync(sckBinary)) {
      log("sck-capture not found — downloading from GitHub Releases...");
      try {
        const { downloadBinary } = await import("./setup-sck-capture.js");
        const success = await downloadBinary({ silent: true });
        if (success) {
          ok("sck-capture downloaded");
        } else {
          warn("sck-capture download failed — audio capture may not work");
        }
      } catch (e) {
        warn(`sck-capture auto-download failed: ${e.message}`);
      }
    }
  }

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
          const depCheck = IS_WINDOWS
            ? 'python3 -c "import PIL; import skimage"'
            : 'python3 -c "import PIL; import skimage; import Quartz; import Vision"';
          execSync(depCheck, { stdio: "pipe" });
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
    const overlay = findOverlay();
    if (overlay?.type === "prebuilt") {
      // Remove macOS quarantine if present (ad-hoc signed app)
      if (!IS_WINDOWS) {
        try {
          const xattrs = execSync(`xattr "${overlay.path}"`, { encoding: "utf-8" });
          if (xattrs.includes("com.apple.quarantine")) {
            execSync(`xattr -dr com.apple.quarantine "${overlay.path}"`, { stdio: "pipe" });
          }
        } catch { /* no quarantine or xattr failed — try launching anyway */ }
      }

      log("Starting overlay (pre-built)...");
      const binary = IS_WINDOWS
        ? overlay.path  // sinain_hud.exe
        : path.join(overlay.path, "Contents/MacOS/sinain_hud");
      startProcess("overlay", binary, [], { color: MAGENTA });
      await sleep(2000);
      const overlayChild = children.find(c => c.name === "overlay");
      if (overlayChild && !overlayChild.proc.killed && overlayChild.proc.exitCode === null) {
        ok(`overlay running (pid:${overlayChild.pid})`);
        overlayStatus = "running";
      } else {
        warn("overlay exited early — check logs above");
        overlayStatus = "failed";
      }
    } else if (overlay?.type === "source") {
      const hasFlutter = commandExists("flutter");
      if (hasFlutter) {
        log("Starting overlay (flutter run)...");
        const device = IS_WINDOWS ? "windows" : "macos";
        startProcess("overlay", "flutter", ["run", "-d", device], {
          cwd: overlay.path,
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
      } else {
        warn("flutter not found — overlay source found but can't build");
      }
    } else {
      // Auto-download overlay if not found
      log("overlay not found — downloading from GitHub Releases...");
      try {
        const { downloadOverlay } = await import("./setup-overlay.js");
        const success = await downloadOverlay({ silent: false });
        if (success) {
          // Re-find and launch the freshly downloaded overlay
          const freshOverlay = findOverlay();
          if (freshOverlay?.type === "prebuilt") {
            if (!IS_WINDOWS) {
              try {
                execSync(`xattr -cr "${freshOverlay.path}"`, { stdio: "pipe" });
              } catch { /* no quarantine */ }
            }
            log("Starting overlay (pre-built)...");
            const binary = IS_WINDOWS
              ? freshOverlay.path
              : path.join(freshOverlay.path, "Contents/MacOS/sinain_hud");
            startProcess("overlay", binary, [], { color: MAGENTA });
            await sleep(2000);
            const overlayChild = children.find(c => c.name === "overlay");
            if (overlayChild && !overlayChild.proc.killed && overlayChild.proc.exitCode === null) {
              ok(`overlay running (pid:${overlayChild.pid})`);
              overlayStatus = "running";
            } else {
              warn("overlay exited early — check logs above");
              overlayStatus = "failed";
            }
          }
        } else {
          warn("overlay auto-download failed — run: sinain setup-overlay");
        }
      } catch (e) {
        warn(`overlay auto-download failed: ${e.message}`);
      }
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

  // Flutter (optional — only needed if no pre-built overlay)
  if (commandExists("flutter")) {
    try {
      const flutterVer = execSync("flutter --version 2>&1", { encoding: "utf-8" }).split("\n")[0].split(" ")[1];
      ok(`flutter ${flutterVer}`);
    } catch {
      ok("flutter (version unknown)");
    }
  } else {
    const prebuiltName = IS_WINDOWS ? "sinain_hud.exe" : "sinain_hud.app";
    const prebuiltApp = path.join(SINAIN_DIR, "overlay-app", prebuiltName);
    if (fs.existsSync(prebuiltApp)) {
      ok("overlay: pre-built app");
    } else {
      warn("no overlay available — run: sinain setup-overlay");
      skipOverlay = true;
    }
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

async function ensureOllama() {
  try {
    const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      ok("ollama server running");
      return true;
    }
  } catch { /* not running */ }

  // Try to start Ollama in background
  log("Starting ollama server...");
  try {
    const { spawn: spawnProc } = await import("child_process");
    spawnProc("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
    // Wait for it to become ready
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          ok("ollama server started");
          return true;
        }
      } catch { /* not ready yet */ }
    }
    warn("ollama started but not responding — local vision may not work");
    return false;
  } catch {
    warn("ollama not found — local vision disabled. Install: brew install ollama");
    return false;
  }
}

// ── Setup wizard ─────────────────────────────────────────────────────────────

async function setupWizard(envPath) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  // Load existing .env values as defaults (for re-configuration)
  const existing = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) existing[m[1]] = m[2];
    }
  }
  const hasExisting = Object.keys(existing).length > 0;

  console.log();
  console.log(`${BOLD}── ${hasExisting ? "Re-configure" : "First-time setup"} ────────────────────${RESET}`);
  console.log(`  Configuring ${DIM}~/.sinain/.env${RESET}`);
  if (hasExisting) console.log(`  ${DIM}Press Enter to keep current values shown in [brackets]${RESET}`);
  console.log();

  const vars = {};

  // 1. Transcription backend — auto-detect whisper-cli
  let transcriptionBackend = "openrouter";
  const hasWhisper = !IS_WINDOWS && commandExists("whisper-cli");

  if (IS_WINDOWS) {
    console.log(`  ${DIM}(Local whisper not available on Windows — using OpenRouter)${RESET}`);
  } else if (hasWhisper) {
    const choice = await ask(`  Transcription backend? [${BOLD}local${RESET}/cloud] (local = whisper-cli, no API key): `);
    if (choice.trim().toLowerCase() === "cloud") {
      transcriptionBackend = "openrouter";
    } else {
      transcriptionBackend = "local";
    }
  } else {
    const installWhisper = await ask(`  whisper-cli not found. Install via Homebrew? [Y/n]: `);
    if (!installWhisper.trim() || installWhisper.trim().toLowerCase() === "y") {
      try {
        console.log(`  ${DIM}Installing whisper-cpp...${RESET}`);
        execSync("brew install whisper-cpp", { stdio: "inherit" });

        // Download model
        const modelDir = path.join(HOME, "models");
        const modelPath = path.join(modelDir, "ggml-large-v3-turbo.bin");
        if (!fs.existsSync(modelPath)) {
          console.log(`  ${DIM}Downloading ggml-large-v3-turbo (~1.5 GB)...${RESET}`);
          fs.mkdirSync(modelDir, { recursive: true });
          execSync(
            `curl -L --progress-bar -o "${modelPath}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"`,
            { stdio: "inherit" }
          );
        }

        transcriptionBackend = "local";
        vars.LOCAL_WHISPER_MODEL = modelPath;
        ok("whisper-cpp installed");
      } catch {
        warn("whisper-cpp install failed — falling back to OpenRouter");
        transcriptionBackend = "openrouter";
      }
    } else {
      transcriptionBackend = "openrouter";
    }
  }
  vars.TRANSCRIPTION_BACKEND = transcriptionBackend;

  // 2. OpenRouter API key (if cloud backend or for vision/OCR)
  if (transcriptionBackend === "openrouter") {
    const existingKey = existing.OPENROUTER_API_KEY;
    const keyHint = existingKey ? ` [${existingKey.slice(0, 8)}...${existingKey.slice(-4)}]` : "";
    let key = "";
    while (!key) {
      key = await ask(`  OpenRouter API key (sk-or-...)${keyHint}: `);
      key = key.trim();
      if (!key && existingKey) { key = existingKey; break; }
      if (key && !key.startsWith("sk-or-")) {
        console.log(`  ${YELLOW}⚠${RESET} Key should start with sk-or-. Try again or press Enter to skip.`);
        const retry = await ask(`  Use this key anyway? [y/N]: `);
        if (retry.trim().toLowerCase() !== "y") { key = ""; continue; }
      }
      if (!key) {
        console.log(`  ${DIM}You can set OPENROUTER_API_KEY later in ~/.sinain/.env${RESET}`);
        break;
      }
    }
    if (key) vars.OPENROUTER_API_KEY = key;
  } else {
    // Still ask for OpenRouter key (needed for vision/OCR)
    const existingKey = existing.OPENROUTER_API_KEY;
    const keyHint = existingKey ? ` [${existingKey.slice(0, 8)}...${existingKey.slice(-4)}]` : "";
    const key = await ask(`  OpenRouter API key for vision/OCR (optional, Enter to skip)${keyHint}: `);
    if (key.trim()) vars.OPENROUTER_API_KEY = key.trim();
    else if (existingKey) vars.OPENROUTER_API_KEY = existingKey;
  }

  // 3. Agent selection
  const defaultAgent = existing.SINAIN_AGENT || "claude";
  const agentChoice = await ask(`  Agent? [${BOLD}${defaultAgent}${RESET}/claude/codex/goose/junie/aider]: `);
  vars.SINAIN_AGENT = agentChoice.trim().toLowerCase() || defaultAgent;

  // 3b. Local vision (Ollama)
  const IS_MACOS = os.platform() === "darwin";
  const hasOllama = commandExists("ollama");
  if (hasOllama) {
    const useVision = await ask(`  Enable local vision AI? [Y/n] (Ollama — screen understanding without cloud API): `);
    if (!useVision.trim() || useVision.trim().toLowerCase() === "y") {
      vars.LOCAL_VISION_ENABLED = "true";
      // Ensure ollama serve is running before list/pull
      const ollamaReady = await ensureOllama();
      if (ollamaReady) {
        try {
          const models = execSync("ollama list 2>/dev/null", { encoding: "utf-8" });
          if (!models.includes("llava")) {
            const pull = await ask(`  Pull llava vision model (~4GB)? [Y/n]: `);
            if (!pull.trim() || pull.trim().toLowerCase() === "y") {
              console.log(`  ${DIM}Pulling llava...${RESET}`);
              execSync("ollama pull llava", { stdio: "inherit" });
              ok("llava model pulled");
            }
          } else {
            ok("llava model already available");
          }
        } catch {
          warn("Could not check Ollama models");
        }
      }
      vars.LOCAL_VISION_MODEL = "llava";
    }
  } else {
    const installOllama = await ask(`  Install Ollama for local vision AI? [y/N]: `);
    if (installOllama.trim().toLowerCase() === "y") {
      try {
        if (IS_MACOS) {
          console.log(`  ${DIM}Installing Ollama via Homebrew...${RESET}`);
          execSync("brew install ollama", { stdio: "inherit" });
        } else {
          console.log(`  ${DIM}Installing Ollama...${RESET}`);
          execSync("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "inherit" });
        }
        // Start ollama serve before pulling
        await ensureOllama();
        console.log(`  ${DIM}Pulling llava vision model...${RESET}`);
        execSync("ollama pull llava", { stdio: "inherit" });
        vars.LOCAL_VISION_ENABLED = "true";
        vars.LOCAL_VISION_MODEL = "llava";
        ok("Ollama + llava installed");
      } catch {
        warn("Ollama installation failed — local vision disabled");
      }
    }
  }

  // 4. Escalation mode
  console.log();
  console.log(`  ${DIM}Escalation modes:${RESET}`);
  console.log(`    off       — no escalation to gateway`);
  console.log(`    selective — score-based (errors, questions trigger it)`);
  console.log(`    focus     — always escalate every tick`);
  console.log(`    rich      — always escalate with maximum context`);
  const defaultEsc = existing.ESCALATION_MODE || "selective";
  const escMode = await ask(`  Escalation mode? [off/${BOLD}${defaultEsc}${RESET}/selective/focus/rich]: `);
  vars.ESCALATION_MODE = escMode.trim().toLowerCase() || defaultEsc;

  // 5. OpenClaw gateway
  const hadGateway = !!(existing.OPENCLAW_WS_URL);
  const gatewayDefault = hadGateway ? "Y" : "N";
  const hasGateway = await ask(`  Do you have an OpenClaw gateway? [${gatewayDefault === "Y" ? "Y/n" : "y/N"}]: `);
  const wantsGateway = hasGateway.trim()
    ? hasGateway.trim().toLowerCase() === "y"
    : hadGateway;
  if (wantsGateway) {
    const defaultWs = existing.OPENCLAW_WS_URL || "ws://localhost:18789";
    const wsUrl = await ask(`  Gateway WebSocket URL [${defaultWs}]: `);
    vars.OPENCLAW_WS_URL = wsUrl.trim() || defaultWs;

    const existingToken = existing.OPENCLAW_WS_TOKEN;
    const tokenHint = existingToken ? ` [${existingToken.slice(0, 6)}...${existingToken.slice(-4)}]` : "";
    const wsToken = await ask(`  Gateway auth token (48-char hex)${tokenHint}: `);
    if (wsToken.trim()) {
      vars.OPENCLAW_WS_TOKEN = wsToken.trim();
      vars.OPENCLAW_HTTP_TOKEN = wsToken.trim();
    } else if (existingToken) {
      vars.OPENCLAW_WS_TOKEN = existingToken;
      vars.OPENCLAW_HTTP_TOKEN = existing.OPENCLAW_HTTP_TOKEN || existingToken;
    }

    // Derive HTTP URL from WS URL
    const httpBase = vars.OPENCLAW_WS_URL.replace(/^ws/, "http");
    vars.OPENCLAW_HTTP_URL = `${httpBase}/hooks/agent`;
    vars.OPENCLAW_SESSION_KEY = existing.OPENCLAW_SESSION_KEY || "agent:main:sinain";
  } else {
    // No gateway — disable WS connection attempts
    vars.OPENCLAW_WS_URL = "";
    vars.OPENCLAW_HTTP_URL = "";
  }

  // 6. Knowledge import (for standalone machines)
  console.log();
  const wantImport = await ask(`  Import knowledge from another machine? [y/N]: `);
  if (wantImport.trim().toLowerCase() === "y") {
    const filePath = await ask(`  Path to knowledge export (.tar.gz): `);
    const resolved = filePath.trim().replace(/^~/, HOME);
    if (resolved && fs.existsSync(resolved)) {
      const targetWorkspace = path.join(HOME, ".sinain/workspace");
      fs.mkdirSync(targetWorkspace, { recursive: true });
      try {
        execSync(`tar xzf "${resolved}" -C "${targetWorkspace}"`, { stdio: "inherit" });
        // Symlink sinain-memory scripts from npm package
        const srcMemory = path.join(PKG_DIR, "sinain-memory");
        const dstMemory = path.join(targetWorkspace, "sinain-memory");
        try { fs.rmSync(dstMemory, { recursive: true }); } catch {}
        fs.symlinkSync(srcMemory, dstMemory);
        vars.SINAIN_WORKSPACE = targetWorkspace;
        vars.OPENCLAW_WORKSPACE_DIR = targetWorkspace;
        ok(`Knowledge imported to ${targetWorkspace}`);
      } catch (e) {
        warn(`Import failed: ${e.message}`);
      }
    } else if (resolved) {
      warn(`File not found: ${resolved}`);
    }
  }

  // 7. Agent-specific defaults
  vars.SINAIN_POLL_INTERVAL = "5";
  vars.SINAIN_HEARTBEAT_INTERVAL = "900";
  vars.PRIVACY_MODE = "standard";

  // Write .env — start from .env.example template, patch wizard values in
  fs.mkdirSync(path.dirname(envPath), { recursive: true });

  const examplePath = path.join(PKG_DIR, ".env.example");
  let template = "";
  if (fs.existsSync(examplePath)) {
    template = fs.readFileSync(examplePath, "utf-8");
  } else {
    // Fallback: try sibling (running from cloned repo)
    const siblingExample = path.join(PKG_DIR, "..", ".env.example");
    if (fs.existsSync(siblingExample)) {
      template = fs.readFileSync(siblingExample, "utf-8");
    }
  }

  if (template) {
    // Patch each wizard var into the template by replacing the KEY=... line
    for (const [key, val] of Object.entries(vars)) {
      // Match KEY=anything (possibly commented out with #)
      const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
      if (regex.test(template)) {
        template = template.replace(regex, `${key}=${val}`);
      } else {
        // Key not in template — append it
        template += `\n${key}=${val}`;
      }
    }
    // Add wizard timestamp header
    template = `# Generated by sinain setup wizard — ${new Date().toISOString()}\n${template}`;
    fs.writeFileSync(envPath, template);
  } else {
    // No template found — write bare vars (fallback)
    const lines = [];
    lines.push("# sinain configuration — generated by setup wizard");
    lines.push(`# ${new Date().toISOString()}`);
    lines.push("");
    for (const [key, val] of Object.entries(vars)) {
      lines.push(`${key}=${val}`);
    }
    lines.push("");
    fs.writeFileSync(envPath, lines.join("\n"));
  }

  rl.close();

  console.log();
  ok(`Config written to ${envPath}`);
  console.log();
}

// ── User environment ────────────────────────────────────────────────────────

function loadUserEnv() {
  const envPaths = [
    path.join(SINAIN_DIR, ".env"),
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

  if (IS_WINDOWS) {
    const exes = ["sinain_hud.exe", "tsx.cmd"];
    for (const exe of exes) {
      try {
        execSync(`taskkill /F /IM "${exe}" 2>NUL`, { stdio: "pipe" });
        killed = true;
      } catch { /* not running */ }
    }
    // Free port 9500
    try {
      const out = execSync('netstat -ano | findstr ":9500" | findstr "LISTENING"', { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      const pid = out.split(/\s+/).pop();
      if (pid && pid !== "0") {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
        killed = true;
      }
    } catch { /* already free */ }
  } else {
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
  }

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

function findOverlay() {
  // 1. Dev monorepo: sibling overlay/ with pubspec.yaml (Flutter source)
  const siblingOverlay = path.join(PKG_DIR, "..", "overlay");
  if (fs.existsSync(path.join(siblingOverlay, "pubspec.yaml"))) {
    return { type: "source", path: siblingOverlay };
  }

  // 2. Pre-built app (downloaded by setup-overlay)
  const prebuiltName = IS_WINDOWS ? "sinain_hud.exe" : "sinain_hud.app";
  const prebuiltApp = path.join(SINAIN_DIR, "overlay-app", prebuiltName);
  if (fs.existsSync(prebuiltApp)) {
    return { type: "prebuilt", path: prebuiltApp };
  }

  // 3. Legacy: ~/.sinain/overlay/ source install (setup-overlay --from-source)
  const installedOverlay = path.join(SINAIN_DIR, "overlay");
  if (fs.existsSync(path.join(installedOverlay, "pubspec.yaml"))) {
    return { type: "source", path: installedOverlay };
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
