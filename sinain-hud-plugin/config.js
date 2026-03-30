#!/usr/bin/env node
/**
 * sinain config — interactive section-based config editor.
 * Edit individual settings without re-running the full onboard wizard.
 */
import * as p from "@clack/prompts";
import {
  c, guard, readEnv, writeEnv, summarizeConfig, runHealthCheck,
  stepApiKey, stepTranscription, stepGateway, stepPrivacy, stepModel, stepAgent,
  ENV_PATH, IS_WINDOWS, HOME, PKG_DIR,
} from "./config-shared.js";
import fs from "fs";
import path from "path";

// ── Section definitions ────────────────────────────────────────────────────

const SECTIONS = [
  { value: "apikey",        label: "API Key",        hint: "OpenRouter API key" },
  { value: "transcription", label: "Transcription",  hint: "Cloud or local whisper" },
  { value: "model",         label: "Model",          hint: "AI model for analysis" },
  { value: "privacy",       label: "Privacy",        hint: "Standard / strict / paranoid" },
  { value: "gateway",       label: "Gateway",        hint: "OpenClaw connection" },
  { value: "agent",         label: "Agent",          hint: "Claude / Codex / Goose / ..." },
  { value: "health",        label: "Health check",   hint: "Test core + gateway status" },
];

// ── Section handlers ───────────────────────────────────────────────────────

async function runSection(section, existing) {
  switch (section) {
    case "apikey": {
      const key = await stepApiKey(existing);
      return { OPENROUTER_API_KEY: key };
    }
    case "transcription": {
      const backend = await stepTranscription(existing);
      const vars = { TRANSCRIPTION_BACKEND: backend };
      if (backend === "local") {
        const modelDir = path.join(HOME, "models");
        const modelPath = path.join(modelDir, "ggml-large-v3-turbo.bin");
        if (fs.existsSync(modelPath)) {
          vars.LOCAL_WHISPER_MODEL = modelPath;
        }
      }
      return vars;
    }
    case "model": {
      const model = await stepModel(existing);
      return { AGENT_MODEL: model };
    }
    case "privacy": {
      const mode = await stepPrivacy(existing);
      return { PRIVACY_MODE: mode };
    }
    case "gateway": {
      return await stepGateway(existing);
    }
    case "agent": {
      const agent = await stepAgent(existing);
      return { SINAIN_AGENT: agent };
    }
    case "health": {
      await runHealthCheck();
      return null; // no vars to write
    }
  }
}

// ── List command ────────────────────────────────────────────────────────────

function printConfigList(existing) {
  const lines = summarizeConfig(existing);
  if (lines.length === 0) {
    console.log(c.dim("  No config found. Run: sinain onboard"));
  } else {
    console.log();
    console.log(c.bold("  Current config") + c.dim(` (${ENV_PATH})`));
    console.log();
    for (const line of lines) console.log(`  ${line}`);
    console.log();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runConfigWizard(sectionsFilter) {
  p.intro("sinain config");

  const existing = readEnv();
  if (Object.keys(existing).length === 0) {
    p.log.warn("No config found. Run sinain onboard first.");
    p.outro("sinain onboard");
    return;
  }

  p.note(summarizeConfig(existing).join("\n"), "Current config");

  // If specific sections requested via --sections, run just those
  if (sectionsFilter && sectionsFilter.length > 0) {
    for (const section of sectionsFilter) {
      const vars = await runSection(section, existing);
      if (vars) {
        Object.assign(existing, vars);
        writeEnv(existing);
        p.log.success(`${section} updated.`);
      }
    }
    p.outro("Done.");
    return;
  }

  // Interactive loop
  while (true) {
    const choice = guard(await p.select({
      message: "What to configure?",
      options: [
        ...SECTIONS,
        { value: "__done", label: "Done", hint: "Save and exit" },
      ],
    }));

    if (choice === "__done") break;

    const vars = await runSection(choice, existing);
    if (vars) {
      Object.assign(existing, vars);
      writeEnv(existing);
      p.log.success(`${choice} updated.`);
    }
  }

  p.outro("Config saved.");
}

// ── CLI entry point ────────────────────────────────────────────────────────

const args = process.argv.slice(3); // skip node, cli.js, "config"

if (args[0] === "list" || args[0] === "ls") {
  printConfigList(readEnv());
} else {
  let sectionsFilter = null;
  for (const arg of args) {
    if (arg.startsWith("--sections=")) {
      sectionsFilter = arg.slice(11).split(",").filter(Boolean);
    }
  }
  runConfigWizard(sectionsFilter).catch((err) => {
    console.error(c.red(`  Error: ${err.message}`));
    process.exit(1);
  });
}
