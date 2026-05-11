#!/usr/bin/env node
/**
 * sinain onboard — interactive setup wizard using @clack/prompts
 * Modeled after `openclaw onboard` for a familiar, polished experience.
 */
import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  c, guard, maskKey, readEnv, writeEnv, writeAgentsConfig, summarizeConfig, runHealthCheck,
  stepApiKey, stepTranscription, stepGateway, stepPrivacy, stepModel,
  HOME, SINAIN_DIR, ENV_PATH, PKG_DIR, IS_WINDOWS, IS_MAC,
} from "./config-shared.js";
import { stepMcpInstall, detectMcpAgents } from "./mcp-register.js";

// ── Header ──────────────────────────────────────────────────────────────────

function printHeader() {
  console.log();
  console.log(c.bold("  ┌─────────────────────────────────────────┐"));
  console.log(c.bold("  │                                         │"));
  console.log(c.bold("  │") + c.cyan("    ╔═╗╦╔╗╔╔═╗╦╔╗╔  ╦ ╦╦ ╦╔╦╗        ") + c.bold("│"));
  console.log(c.bold("  │") + c.cyan("    ╚═╗║║║║╠═╣║║║║  ╠═╣║ ║ ║║        ") + c.bold("│"));
  console.log(c.bold("  │") + c.cyan("    ╚═╝╩╝╚╝╩ ╩╩╝╚╝  ╩ ╩╚═╝═╩╝        ") + c.bold("│"));
  console.log(c.bold("  │") + c.dim("      Privacy-first AI overlay          ") + c.bold("│"));
  console.log(c.bold("  │                                         │"));
  console.log(c.bold("  └─────────────────────────────────────────┘"));
  console.log();
}

// ── Steps (imported from config-shared.js) ──────────────────────────────────
// stepApiKey, stepTranscription, stepGateway, stepPrivacy, stepModel
// are imported above and accept an optional label parameter.

async function stepOverlay(existing) {
  // Check if overlay is already installed
  const overlayPaths = [
    path.join(SINAIN_DIR, "overlay", "SinainHUD.app"),
    path.join(SINAIN_DIR, "overlay", "sinain_hud.exe"),
  ];
  const overlayInstalled = overlayPaths.some((p) => fs.existsSync(p));

  const choice = guard(await p.select({
    message: "Install overlay",
    options: [
      {
        value: "download",
        label: "Download pre-built app (recommended)",
        hint: "No Flutter SDK needed",
      },
      {
        value: "source",
        label: "Build from source",
        hint: "Requires Flutter SDK",
      },
      {
        value: "skip",
        label: overlayInstalled ? "Skip (already installed)" : "Skip for now",
        hint: overlayInstalled ? "SinainHUD.app detected" : "Install later: sinain setup-overlay",
      },
    ],
    initialValue: overlayInstalled ? "skip" : "download",
  }));

  if (choice === "download" || choice === "source") {
    const s = p.spinner();
    const label = choice === "download" ? "Downloading overlay..." : "Building overlay from source...";
    s.start(label);
    try {
      // setup-overlay.js handles both modes via process.argv
      if (choice === "source") process.argv.push("--from-source");
      await import("./setup-overlay.js");
      s.stop(c.green("Overlay installed."));
    } catch (err) {
      s.stop(c.yellow(`Failed: ${err.message}`));
      p.note("Install manually: sinain setup-overlay", "Overlay");
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runOnboard(args = {}) {
  printHeader();
  p.intro("SinainHUD setup");

  const existing = readEnv(ENV_PATH);
  const hasExisting = Object.keys(existing).length > 0;

  // ── Existing config handling ────────────────────────────────────────────

  let configAction = "fresh";
  if (hasExisting) {
    p.note(summarizeConfig(existing).join("\n"), "Existing config detected");

    configAction = guard(await p.select({
      message: "Config handling",
      options: [
        { value: "keep", label: "Use existing values" },
        { value: "update", label: "Update values" },
        { value: "reset", label: "Reset (start fresh)" },
      ],
      initialValue: "keep",
    }));

    if (configAction === "keep") {
      p.log.success("Using existing configuration.");
      await stepOverlay(existing);
      await runHealthCheck();
      printOutro();
      return;
    }

    if (configAction === "reset") {
      fs.unlinkSync(ENV_PATH);
      p.log.info("Config reset.");
    }
  }

  const base = configAction === "update" ? existing : {};

  // ── Flow selection ──────────────────────────────────────────────────────

  const flow = args.flow || guard(await p.select({
    message: "Setup mode",
    options: [
      {
        value: "quickstart",
        label: "QuickStart",
        hint: "Get running in 2 minutes. Configure details later.",
      },
      {
        value: "advanced",
        label: "Advanced",
        hint: "Full control over privacy, models, and connections.",
      },
    ],
    initialValue: "quickstart",
  }));

  const totalSteps = flow === "quickstart" ? 2 : 6;

  // ── Collect vars ────────────────────────────────────────────────────────

  const vars = { ...base };
  // agents.json patch — accumulated from steps that touch the openclaw
  // profile / escalation / default agent. Written once after all steps
  // complete so we don't churn ~/.sinain/agents.json on every prompt.
  let agentsPatch = {};

  // Step 1: API key (both flows)
  const apiKey = await stepApiKey(base, `[1/${totalSteps}] OpenRouter API key`);
  vars.OPENROUTER_API_KEY = apiKey;
  p.log.success("API key saved.");

  if (flow === "quickstart") {
    // QuickStart: sensible defaults + a single opt-in question for OpenClaw.
    // Gateway integration is off by default; users who want it run Advanced
    // (or answer Yes here, which then walks them through stepGateway).
    vars.TRANSCRIPTION_BACKEND = base.TRANSCRIPTION_BACKEND || "openrouter";
    vars.PRIVACY_MODE = base.PRIVACY_MODE || "standard";
    vars.AGENT_MODEL = base.AGENT_MODEL || "google/gemini-2.5-flash-lite";

    // Ask explicitly so first-run installs don't silently inherit a gateway
    // profile from agents.example.json. Default reflects current state — No
    // for fresh installs (silences the WS reconnect loop), Yes for re-runs
    // that already had OpenClaw configured (so we don't surprise-delete it).
    const hasExistingGateway = (() => {
      try {
        const agentsPath = path.join(SINAIN_DIR, "agents.json");
        if (!fs.existsSync(agentsPath)) return false;
        const cfg = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
        return !!cfg?.profiles?.openclaw;
      } catch { return false; }
    })();
    const enableGateway = guard(await p.confirm({
      message: "Enable OpenClaw gateway integration?",
      initialValue: hasExistingGateway,
    }));

    agentsPatch = {
      default: base.SINAIN_AGENT || "claude",
      // No `escalationMode` written — lane (default agent) is the single
      // source of truth for whether escalation runs. If the user picks a
      // local agent (claude), the runtime's default mode ("rich" from
      // config.ts) takes effect and registerBareAgent ensures lane and
      // mode stay reconciled at boot.
    };

    if (enableGateway) {
      // Walk through full gateway setup (URL, tokens, session key) — same
      // step Advanced uses. Returns { envVars, agentsPatch } we merge in.
      const gatewayResult = await stepGateway(base, "OpenClaw gateway");
      Object.assign(vars, gatewayResult.envVars);
      Object.assign(agentsPatch, gatewayResult.agentsPatch);
    } else {
      // Explicitly clear any inherited openclaw profile so the runtime
      // doesn't auto-register the gateway or attempt WS reconnects.
      agentsPatch.openclawProfile = null;
    }

    p.note(
      [
        `Transcription: ${vars.TRANSCRIPTION_BACKEND}`,
        `Privacy: ${vars.PRIVACY_MODE}`,
        `Model: ${vars.AGENT_MODEL}`,
        `OpenClaw gateway: ${enableGateway ? "enabled" : "disabled"}`,
        `Escalation: ${agentsPatch.escalationMode || "off"}`,
        "",
        `Change later: sinain config`,
      ].join("\n"),
      "QuickStart defaults",
    );

    // QuickStart MCP install: a single confirm gated on at least one
    // detected agent. Avoids interrupting users who don't have any
    // MCP-aware agent installed. Re-runnable later via `sinain mcp install`.
    try {
      const detected = (await detectMcpAgents()).filter((a) => a.present);
      if (detected.length > 0) {
        const labels = detected.map((a) => a.label).join(", ");
        const wantMcp = guard(await p.confirm({
          message: `Detected ${labels} — register sinain MCP for them?`,
          initialValue: true,
        }));
        if (wantMcp) {
          await stepMcpInstall(base, "Connect MCP agents");
        }
      }
    } catch (err) {
      p.log.info(`Skipping MCP setup: ${err.message}`);
    }
  } else {
    // Advanced flow: steps 2-6 (MCP install is step 6)
    const transcription = await stepTranscription(base, "[2/6] Audio transcription");
    vars.TRANSCRIPTION_BACKEND = transcription;
    p.log.success(`Using ${transcription === "openrouter" ? "cloud" : "local"} transcription.`);

    if (transcription === "local") {
      const modelDir = path.join(HOME, "models");
      const modelPath = path.join(modelDir, "ggml-large-v3-turbo.bin");
      if (!fs.existsSync(modelPath)) {
        const download = guard(await p.confirm({
          message: "Download Whisper model (~1.5 GB)?",
          initialValue: true,
        }));
        if (download) {
          const s = p.spinner();
          s.start("Downloading Whisper model...");
          try {
            fs.mkdirSync(modelDir, { recursive: true });
            execFileSync("curl", [
              "-L", "--progress-bar",
              "-o", modelPath,
              "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
            ], { stdio: "inherit" });
            s.stop(c.green("Model downloaded."));
            vars.LOCAL_WHISPER_MODEL = modelPath;
          } catch {
            s.stop(c.yellow("Download failed. You can download manually later."));
          }
        }
      } else {
        vars.LOCAL_WHISPER_MODEL = modelPath;
        p.log.info(`Whisper model found: ${c.dim(modelPath)}`);
      }
    }

    // If Ollama is installed, offer to pull a local LLM for paranoid-mode
    // analysis. Mirrors the whisper download pattern — auto-acquire optional,
    // user can `ollama pull <model>` manually later if they skip here.
    let ollamaInstalled = false;
    try {
      execFileSync("ollama", ["--version"], { stdio: "ignore" });
      ollamaInstalled = true;
    } catch { /* ollama not on PATH */ }

    if (ollamaInstalled) {
      const pullOllama = guard(await p.confirm({
        message: "Pull an Ollama model for paranoid-mode analysis (~4.7 GB for llava)?",
        initialValue: true,
      }));
      if (pullOllama) {
        const modelName = guard(await p.text({
          message: "Ollama model to pull",
          placeholder: "llava",
          defaultValue: "llava",
        }));
        const s = p.spinner();
        s.start(`Pulling ${modelName} via Ollama (this can take several minutes)...`);
        try {
          execFileSync("ollama", ["pull", modelName], { stdio: "inherit" });
          s.stop(c.green(`Pulled ${modelName}.`));
        } catch {
          s.stop(c.yellow(`Pull failed. Run \`ollama pull ${modelName}\` manually later.`));
        }
      }
    }

    // OpenClaw gateway is opt-in: most users run sinain in standalone mode
    // and never need a gateway. Default the prompt to "No" on fresh installs
    // (when no openclaw profile already exists) so accepting all wizard
    // defaults never silently provisions a gateway profile or starts a WS
    // reconnect loop. Mirrors the Quick-path gate at line ~177.
    const hasExistingGateway = (() => {
      try {
        const agentsPath = path.join(SINAIN_DIR, "agents.json");
        if (!fs.existsSync(agentsPath)) return false;
        const cfg = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
        return !!cfg?.profiles?.openclaw;
      } catch { return false; }
    })();
    const enableGateway = guard(await p.confirm({
      message: "[3/6] Configure OpenClaw gateway?",
      initialValue: hasExistingGateway,
    }));
    if (enableGateway) {
      // stepGateway returns { envVars, agentsPatch }: tokens go to .env,
      // URLs + session + escalation mode go to agents.json's openclaw profile.
      const gatewayResult = await stepGateway(base, "[3/6] OpenClaw gateway");
      Object.assign(vars, gatewayResult.envVars);
      Object.assign(agentsPatch, gatewayResult.agentsPatch);
      if (gatewayResult.agentsPatch.escalationMode === "off") {
        p.log.info("Standalone mode (no gateway).");
      } else {
        p.log.success("Gateway configured.");
      }
    } else {
      // Explicitly clear any inherited openclaw profile so the runtime doesn't
      // auto-register the gateway or attempt WS reconnects (matches Quick path).
      agentsPatch.openclawProfile = null;
      p.log.info("Standalone mode (no gateway).");
    }

    const privacy = await stepPrivacy(base, "[4/6] Privacy mode");
    vars.PRIVACY_MODE = privacy;
    p.log.success(`Privacy: ${privacy}.`);

    const model = await stepModel(base, "[5/6] AI model for HUD analysis");
    vars.AGENT_MODEL = model;
    p.log.success(`Model: ${model}.`);

    // Default agent goes into agents.json `default` field (was SINAIN_AGENT
    // env var). Overlay's chip selector lets the user switch at runtime.
    agentsPatch.default = base.SINAIN_AGENT || "claude";

    // Step 6: register sinain MCP with locally-installed MCP-aware agents
    // (Claude Code, Cursor, Codex, Goose, Junie, Claude Desktop). Detection
    // is non-destructive — if no agents are installed, the step prints a
    // skip note and returns. Idempotent across re-runs.
    await stepMcpInstall(base, "[6/6] Connect MCP agents");
  }

  // ── Common defaults ───────────────────────────────────────────────────

  vars.SINAIN_CORE_URL = vars.SINAIN_CORE_URL || "http://localhost:9500";
  vars.SINAIN_POLL_INTERVAL = vars.SINAIN_POLL_INTERVAL || "5";
  vars.SINAIN_HEARTBEAT_INTERVAL = vars.SINAIN_HEARTBEAT_INTERVAL || "900";
  vars.AUDIO_CAPTURE_CMD = vars.AUDIO_CAPTURE_CMD || "screencapturekit";
  vars.AUDIO_AUTO_START = vars.AUDIO_AUTO_START || "true";
  vars.PORT = vars.PORT || "9500";

  // ── Write config ──────────────────────────────────────────────────────
  // Two files: ~/.sinain/.env for secrets + infra, ~/.sinain/agents.json
  // for agent + gateway config (the migrated keys).

  const s = p.spinner();
  s.start("Writing configuration...");
  writeEnv(vars);
  if (Object.keys(agentsPatch).length > 0) {
    writeAgentsConfig(agentsPatch);
  }
  s.stop(c.green(`Config saved: ${c.dim(ENV_PATH)} + ~/.sinain/agents.json`));

  // ── Overlay ───────────────────────────────────────────────────────────

  await stepOverlay(base);

  // ── Embedding model ───────────────────────────────────────────────────
  // Pre-cache Xenova/all-MiniLM-L6-v2 (~90MB) so sinain-core startup is
  // a cache-hit with no network activity. Helps all users, not just paranoid
  // mode — runtime load goes from ~10s download to <1s cache read.

  {
    const s = p.spinner();
    s.start("Pre-caching sentence-transformer model (~90MB)...");
    try {
      const { cacheEmbeddingModel } = await import("./setup-embedding.js");
      await cacheEmbeddingModel({ silent: true });
      s.stop(c.green("Embedding model cached."));
    } catch (err) {
      s.stop(c.yellow(`Embedding model pre-cache skipped: ${err.message}`));
      p.note(
        "Run manually: sinain setup-embedding\nOr set SINAIN_SKIP_EMBEDDING_SETUP=1 to skip.",
        "Embedding",
      );
    }
  }

  // ── Health check ──────────────────────────────────────────────────────

  await runHealthCheck();

  // ── What now ──────────────────────────────────────────────────────────

  printOutro();

  // ── Start? ────────────────────────────────────────────────────────────
  //
  // When called from launcher.js (via `sinain start --setup`), the launcher
  // is about to start sinain itself — asking the user again is redundant.
  // Caller passes { skipLaunchPrompt: true } in that case.

  if (args.skipLaunchPrompt) {
    p.outro("Setup complete — starting sinain...");
    return;
  }

  const startNow = guard(await p.confirm({
    message: "Start sinain now?",
    initialValue: true,
  }));

  if (startNow) {
    p.outro("Launching sinain...");
    try {
      await import("./launcher.js");
    } catch (err) {
      console.log(c.yellow(`  Launch failed: ${err.message}`));
      console.log(c.dim("  Try manually: sinain start"));
    }
  } else {
    p.outro("Run when ready: sinain start");
  }
}

function printOutro() {
  const hotkey = IS_WINDOWS ? "Ctrl+Shift" : "Cmd+Shift";
  p.note(
    [
      "Hotkeys:",
      `  ${hotkey}+Space — Show/hide overlay`,
      `  ${hotkey}+E     — Cycle tabs (Stream → Agent → Tasks)`,
      `  ${hotkey}+C     — Toggle click-through`,
      `  ${hotkey}+M     — Cycle display mode`,
      "",
      "Docs: https://github.com/geravant/sinain-hud",
      "Re-run: sinain onboard (or sinain onboard --advanced)",
    ].join("\n"),
    "What now",
  );
}

// ── CLI entry point ─────────────────────────────────────────────────────────
//
// Guarded so `import { runOnboard } from "./onboard.js"` from launcher.js
// (or anywhere else) doesn't trigger side effects. The CLI block runs only
// when this file is the program's entry point — i.e. `node onboard.js ...`
// or `npx @geravant/sinain onboard ...`.

const isMainModule = import.meta.url === new URL(`file://${process.argv[1]}`).href
  || (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])));

if (!isMainModule) {
  // Imported as a module — exports are available; do not parse argv.
} else {

const cliArgs = process.argv.slice(2);
const flags = {};
for (const arg of cliArgs) {
  if (arg === "--advanced") flags.flow = "advanced";
  if (arg === "--quickstart") flags.flow = "quickstart";
  if (arg.startsWith("--key=")) flags.key = arg.slice(6);
  if (arg === "--non-interactive") flags.nonInteractive = true;
  if (arg === "--reset") flags.reset = true;
}

if (flags.reset) {
  if (fs.existsSync(ENV_PATH)) {
    fs.unlinkSync(ENV_PATH);
    console.log(c.green("  Config reset."));
  }
}

if (flags.nonInteractive) {
  // .env: secrets + infra. Agent + gateway config goes to agents.json.
  const vars = {
    OPENROUTER_API_KEY: flags.key || process.env.OPENROUTER_API_KEY || "",
    TRANSCRIPTION_BACKEND: "openrouter",
    PRIVACY_MODE: "standard",
    AGENT_MODEL: "google/gemini-2.5-flash-lite",
    PORT: "9500",
    AUDIO_CAPTURE_CMD: "screencapturekit",
    AUDIO_AUTO_START: "true",
    SINAIN_CORE_URL: "http://localhost:9500",
    SINAIN_HEARTBEAT_INTERVAL: "900",
  };

  if (!vars.OPENROUTER_API_KEY) {
    console.error(c.red("  --key=<key> or OPENROUTER_API_KEY required for non-interactive mode."));
    process.exit(1);
  }

  writeEnv(vars);
  // Default agent + openclaw explicitly disabled. No escalation mode written
  // — lane is the source of truth, registerBareAgent reconciles at boot.
  writeAgentsConfig({ default: "claude", openclawProfile: null });
  console.log(c.green(`  Config written to ${ENV_PATH} + ~/.sinain/agents.json`));
  process.exit(0);
} else {
  runOnboard(flags).catch((err) => {
    console.error(c.red(`  Error: ${err.message}`));
    process.exit(1);
  });
}

}  // end isMainModule guard
