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
  c, guard, maskKey, readEnv, writeEnv, summarizeConfig, runHealthCheck,
  stepApiKey, stepTranscription, stepGateway, stepPrivacy, stepModel,
  HOME, SINAIN_DIR, ENV_PATH, PKG_DIR, IS_WINDOWS, IS_MAC,
} from "./config-shared.js";

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

  const totalSteps = flow === "quickstart" ? 2 : 5;

  // ── Collect vars ────────────────────────────────────────────────────────

  const vars = { ...base };

  // Step 1: API key (both flows)
  const apiKey = await stepApiKey(base, `[1/${totalSteps}] OpenRouter API key`);
  vars.OPENROUTER_API_KEY = apiKey;
  p.log.success("API key saved.");

  if (flow === "quickstart") {
    // QuickStart: sensible defaults
    vars.TRANSCRIPTION_BACKEND = base.TRANSCRIPTION_BACKEND || "openrouter";
    vars.PRIVACY_MODE = base.PRIVACY_MODE || "standard";
    vars.AGENT_MODEL = base.AGENT_MODEL || "google/gemini-2.5-flash-lite";
    vars.ESCALATION_MODE = base.ESCALATION_MODE || "off";
    vars.SINAIN_AGENT = base.SINAIN_AGENT || "claude";
    if (!vars.OPENCLAW_WS_URL) {
      vars.OPENCLAW_WS_URL = "";
      vars.OPENCLAW_HTTP_URL = "";
    }

    p.note(
      [
        `Transcription: ${vars.TRANSCRIPTION_BACKEND}`,
        `Privacy: ${vars.PRIVACY_MODE}`,
        `Model: ${vars.AGENT_MODEL}`,
        `Escalation: ${vars.ESCALATION_MODE}`,
        "",
        `Change later: sinain config`,
      ].join("\n"),
      "QuickStart defaults",
    );
  } else {
    // Advanced flow: steps 2-5
    const transcription = await stepTranscription(base, "[2/5] Audio transcription");
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

    const gatewayVars = await stepGateway(base, "[3/5] OpenClaw gateway");
    Object.assign(vars, gatewayVars);
    if (gatewayVars.ESCALATION_MODE === "off") {
      p.log.info("Standalone mode (no gateway).");
    } else {
      p.log.success("Gateway configured.");
    }

    const privacy = await stepPrivacy(base, "[4/5] Privacy mode");
    vars.PRIVACY_MODE = privacy;
    p.log.success(`Privacy: ${privacy}.`);

    const model = await stepModel(base, "[5/5] AI model for HUD analysis");
    vars.AGENT_MODEL = model;
    p.log.success(`Model: ${model}.`);

    vars.SINAIN_AGENT = base.SINAIN_AGENT || "claude";
  }

  // ── Common defaults ───────────────────────────────────────────────────

  vars.SINAIN_CORE_URL = vars.SINAIN_CORE_URL || "http://localhost:9500";
  vars.SINAIN_POLL_INTERVAL = vars.SINAIN_POLL_INTERVAL || "5";
  vars.SINAIN_HEARTBEAT_INTERVAL = vars.SINAIN_HEARTBEAT_INTERVAL || "900";
  vars.AUDIO_CAPTURE_CMD = vars.AUDIO_CAPTURE_CMD || "screencapturekit";
  vars.AUDIO_AUTO_START = vars.AUDIO_AUTO_START || "true";
  vars.PORT = vars.PORT || "9500";

  // ── Write config ──────────────────────────────────────────────────────

  const s = p.spinner();
  s.start("Writing configuration...");
  writeEnv(vars);
  s.stop(c.green(`Config saved: ${c.dim(ENV_PATH)}`));

  // ── Overlay ───────────────────────────────────────────────────────────

  await stepOverlay(base);

  // ── Health check ──────────────────────────────────────────────────────

  await runHealthCheck();

  // ── What now ──────────────────────────────────────────────────────────

  printOutro();

  // ── Start? ────────────────────────────────────────────────────────────

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
  const vars = {
    OPENROUTER_API_KEY: flags.key || process.env.OPENROUTER_API_KEY || "",
    TRANSCRIPTION_BACKEND: "openrouter",
    PRIVACY_MODE: "standard",
    AGENT_MODEL: "google/gemini-2.5-flash-lite",
    ESCALATION_MODE: "off",
    SINAIN_AGENT: "claude",
    OPENCLAW_WS_URL: "",
    OPENCLAW_HTTP_URL: "",
    PORT: "9500",
    AUDIO_CAPTURE_CMD: "screencapturekit",
    AUDIO_AUTO_START: "true",
    SINAIN_CORE_URL: "http://localhost:9500",
    SINAIN_POLL_INTERVAL: "5",
    SINAIN_HEARTBEAT_INTERVAL: "900",
  };

  if (!vars.OPENROUTER_API_KEY) {
    console.error(c.red("  --key=<key> or OPENROUTER_API_KEY required for non-interactive mode."));
    process.exit(1);
  }

  writeEnv(vars);
  console.log(c.green(`  Config written to ${ENV_PATH}`));
  process.exit(0);
} else {
  runOnboard(flags).catch((err) => {
    console.error(c.red(`  Error: ${err.message}`));
    process.exit(1);
  });
}
