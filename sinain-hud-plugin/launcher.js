#!/usr/bin/env node
// sinain launcher — process orchestrator for `sinain start`
// Ports the logic from start.sh + sinain-agent-runner/run.sh into a single Node.js process manager.

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
  // ── Platform guard (ENG-05, CONTEXT.md D-03) ─────────────────────────────
  // Friendly blocker for non-macOS platforms. SINAIN_FAKE_PLATFORM enables
  // env-var spoof testing without an actual Windows/Linux host.
  const platform = process.env.SINAIN_FAKE_PLATFORM || os.platform();
  if (platform !== "darwin") {
    const isWindows = platform === "win32";
    console.log("");
    console.log("  ┌─────────────────────────────────────────────────────────┐");
    console.log("  │  Sinain is macOS-only for this launch                   │");
    console.log("  │                                                         │");
    console.log("  │  " + (isWindows
      ? "Windows support is in progress — star the repo for updates."
      : "Linux support is planned — star the repo for updates.        ") + "  │");
    console.log("  │  https://github.com/geravant/sinain-hud                 │");
    console.log("  └─────────────────────────────────────────────────────────┘");
    console.log("");
    process.exit(0);
  }
  // ── End platform guard ────────────────────────────────────────────────────

  setupSignalHandlers();

  log("Preflight checks...");
  await preflight();
  console.log();

  // Run setup wizard on first launch (no ~/.sinain/.env) or when --setup flag is passed
  //
  // Delegates to onboard.js's clack-based runOnboard (Mitch's wizard from
  // PR #43). Previously, launcher.js had its own readline-based setupWizard
  // that diverged from `npx sinain onboard`'s flow — same package, two
  // different setup experiences depending on entry point. This collapses
  // both paths to a single source of truth in config-shared.js.
  //
  // skipLaunchPrompt: true tells runOnboard not to ask "start sinain now?"
  // at the end — we're already inside the launcher and will continue
  // start-up automatically once the wizard returns.
  const userEnvPath = path.join(SINAIN_DIR, ".env");
  const envExists = fs.existsSync(userEnvPath);
  if (forceSetup || !envExists) {
    log(envExists ? "Re-running setup wizard (--setup flag)..." : "First-time setup — running wizard...");
    const { runOnboard } = await import("./onboard.js");
    await runOnboard({ skipLaunchPrompt: true });
  } else {
    log(`Existing config found at ${DIM}${userEnvPath}${RESET} — skipping wizard. (Use ${BOLD}--setup${RESET} to re-configure.)`);
  }

  // Load user config
  loadUserEnv();

  // Propagate unified local mode config to component-level vars
  if (process.env.SINAIN_LOCAL_MODE === "true") {
    const llm = process.env.SINAIN_LOCAL_LLM || "phi4-mini";
    const vision = process.env.SINAIN_LOCAL_VISION || "qwen2.5vl:7b";
    if (!process.env.LOCAL_VISION_ENABLED) process.env.LOCAL_VISION_ENABLED = "true";
    if (!process.env.LOCAL_VISION_MODEL) process.env.LOCAL_VISION_MODEL = vision;
    if (!process.env.ANALYSIS_PROVIDER) process.env.ANALYSIS_PROVIDER = "ollama";
    if (!process.env.ANALYSIS_MODEL) process.env.ANALYSIS_MODEL = llm;
    if (!process.env.TRANSCRIPTION_BACKEND) process.env.TRANSCRIPTION_BACKEND = "local";
    if (!process.env.SINAIN_FAST_MODEL) process.env.SINAIN_FAST_MODEL = `ollama/${llm}`;
    if (!process.env.SINAIN_SMART_MODEL) process.env.SINAIN_SMART_MODEL = `ollama/${llm}`;
    log(`${MAGENTA}LOCAL MODE${RESET} — LLM: ${llm}, Vision: ${vision}`);
  }

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

  // Pre-cache embedding model if not already cached (prevents 10s huggingface.co
  // download at sinain-core first-startup; skipped silently if SINAIN_SKIP_EMBEDDING_SETUP=1)
  if (process.env.SINAIN_SKIP_EMBEDDING_SETUP !== "1") {
    try {
      const { cacheEmbeddingModel } = await import("./setup-embedding.js");
      await cacheEmbeddingModel({ silent: true });
    } catch (e) {
      warn(`embedding model pre-cache skipped: ${e.message}`);
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

  // Health check (local mode needs longer — cold model load + startup distillation)
  const healthTimeout = process.env.SINAIN_LOCAL_MODE === "true" ? 45 : 20;
  const healthy = await healthCheck("http://localhost:9500/health", healthTimeout);
  if (!healthy) {
    fail(`sinain-core did not become healthy after ${healthTimeout}s`);
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

  // Start sinain chat sidecar (the built-in "sinain" chat lane — a resident
  // OpenHands agent on :9610). Bundled with the package; launched here like
  // sense_client. Degrades gracefully: if python3 / the key / deps are
  // missing it's skipped, and the user can pick a CLI chat agent instead.
  let chatStatus = "skipped";
  {
    const chatDir = path.join(PKG_DIR, "sinain-chat-agent");
    const sidecar = path.join(chatDir, "sidecar.py");
    // Local mode (ollama) needs no OpenRouter key — only the cloud path does.
    const chatLocal = process.env.SINAIN_LOCAL_MODE === "true"
      || ["ollama", "local"].includes((process.env.SINAIN_CHAT_PROVIDER || "").toLowerCase());
    if (!commandExists("python3")) {
      warn("python3 not found — sinain chat sidecar skipped (pick a CLI chat agent)");
    } else if (!fs.existsSync(sidecar)) {
      // Not bundled (older package) — skip silently.
    } else if (!chatLocal && !process.env.OPENROUTER_API_KEY) {
      warn("OPENROUTER_API_KEY not set — sinain chat sidecar skipped (set the key, enable local mode, or pick a CLI chat agent)");
    } else {
      // Prefer the sidecar's own .venv (dev); else system python3 (prod —
      // deps are pip-installed into the system interpreter below).
      const venvPy = path.join(chatDir, ".venv", "bin", "python");
      const chatPy = fs.existsSync(venvPy) ? venvPy : "python3";
      const reqFile = path.join(chatDir, "requirements.txt");
      if (fs.existsSync(reqFile)) {
        try {
          execSync(`"${chatPy}" -c "import openhands.sdk; import websockets"`, { stdio: "pipe" });
        } catch {
          log("Installing sinain chat sidecar Python dependencies (first run may take a minute)...");
          try {
            if (chatPy === "python3") {
              execSync(`pip3 install -r "${reqFile}" --quiet --break-system-packages`, { stdio: "inherit" });
            } else {
              execSync(`"${chatPy}" -m pip install -r "${reqFile}" --quiet`, { stdio: "inherit" });
            }
          } catch {
            try {
              execSync(`pip3 install -r "${reqFile}" --quiet`, { stdio: "inherit" });
            } catch {
              warn("pip3 install failed — sinain chat sidecar may not work");
            }
          }
        }
      }
      log("Starting sinain chat sidecar...");
      startProcess("chat", chatPy, ["sidecar.py"], {
        cwd: chatDir,
        color: MAGENTA,
      });
      // OpenHands warm-up takes a moment; give it time to fail fast if misconfigured.
      await sleep(1500);
      const chatChild = children.find(c => c.name === "chat");
      if (chatChild && !chatChild.proc.killed && chatChild.proc.exitCode === null) {
        ok(`sinain chat sidecar running (pid:${chatChild.pid})`);
        chatStatus = "running";
      } else {
        warn("sinain chat sidecar exited early — check logs above");
        chatStatus = "failed";
      }
    }
  }

  // Start overlay
  let overlayStatus = "skipped";
  if (!skipOverlay) {
    // ALWAYS check for an overlay update before launching — setup-overlay's
    // own version.json marker decides whether to skip a download (fast)
    // or fetch a new release (slow). Previously we only ran setup-overlay
    // when no binary existed, which meant users with a stale binary from
    // a months-old install ran an outdated overlay forever (no flash icon,
    // no AgentSelectorPanel, no per-lane routing UI). When --setup is
    // passed, force-update regardless of the marker.
    try {
      const { downloadOverlay } = await import("./setup-overlay.js");
      await downloadOverlay({ silent: false, forceUpdate: forceSetup });
    } catch (e) {
      warn(`overlay update check failed: ${e.message} — using local binary`);
    }
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
    const runSh = path.join(PKG_DIR, "sinain-agent-runner/run.sh");
    if (fs.existsSync(runSh)) {
      // Generate MCP config with absolute paths
      const mcpConfigPath = generateMcpConfig();

      // Resolve agent name
      const agent = agentName || process.env.SINAIN_AGENT || "claude";

      log(`Starting agent (${agent})...`);
      startProcess("agent", "bash", [runSh], {
        cwd: path.join(PKG_DIR, "sinain-agent-runner"),
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
      warn("sinain-agent-runner/run.sh not found — agent skipped");
    }
  }

  // Write PID file
  writePidFile();

  // Banner
  printBanner({ senseStatus, chatStatus, overlayStatus, agentStatus });

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
      warn("no overlay available — will auto-download from GitHub Releases");
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
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const ci = val.search(/\s+#/);
        if (ci !== -1) val = val.slice(0, ci).trimEnd();
      }
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
      "sinain-chat-agent/sidecar.py",
      "python3 sidecar.py",
      "Python sidecar.py",
      "tsx.*src/index.ts",
      "tsx watch src/index.ts",
      "sinain-agent-runner/run.sh",
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

function printBanner({ senseStatus, chatStatus, overlayStatus, agentStatus }) {
  console.log();
  console.log(`${BOLD}── SinainHUD ──────────────────────────${RESET}`);

  // Core (always running if we got here)
  console.log(`  ${CYAN}core${RESET}     :9500   ${GREEN}✓${RESET}  (http+ws)`);

  // Sense
  printServiceLine("sense", YELLOW, senseStatus);

  // Chat sidecar (built-in sinain chat lane on :9610)
  printServiceLine("chat", MAGENTA, chatStatus);

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
