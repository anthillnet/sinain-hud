/**
 * sinain mcp-register — detect and register the sinain MCP server
 * into MCP-aware agents (Claude Code, Claude Desktop, Cursor, Codex, Goose, Junie).
 *
 * Designed to be called from two surfaces:
 *   - the wizard (`stepMcpInstall` from onboard.js)
 *   - a standalone CLI (`runMcpCli` from cli.js)
 *
 * Idempotency is the design contract for every backend: read existing config,
 * upsert the `sinain` entry only, never duplicate. Re-running this module
 * after upgrading the npm package is the canonical "re-point my paths" flow.
 */

import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, execSync } from "child_process";
import { c, guard, cmdExists, PKG_DIR, HOME, SINAIN_DIR, ENV_PATH, IS_WINDOWS, IS_MAC } from "./config-shared.js";

// ── Paths to the bundled MCP server ─────────────────────────────────────────

const MCP_SERVER_DIR = path.join(PKG_DIR, "sinain-mcp-server");
const MCP_ENTRY = path.join(MCP_SERVER_DIR, "index.ts");
const TSX_BIN = path.join(MCP_SERVER_DIR, "node_modules", ".bin", IS_WINDOWS ? "tsx.cmd" : "tsx");

const DEFAULT_ENV = {
  SINAIN_CORE_URL: "http://localhost:9500",
  SINAIN_WORKSPACE: path.join(HOME, ".openclaw", "workspace"),
};

function mcpServerReady() {
  return fs.existsSync(MCP_ENTRY) && fs.existsSync(TSX_BIN);
}

function ensureMcpServerDeps() {
  if (mcpServerReady()) return true;
  if (!fs.existsSync(MCP_ENTRY)) return false;
  try {
    execSync("npm install --silent", { cwd: MCP_SERVER_DIR, stdio: "pipe" });
    return mcpServerReady();
  } catch {
    return false;
  }
}

function mcpServerPayload() {
  return {
    command: TSX_BIN,
    args: [MCP_ENTRY],
    env: { ...DEFAULT_ENV },
  };
}

// ── Backend: Claude Code (CLI-managed via `claude mcp`) ─────────────────────

function claudeListJson() {
  try {
    const out = execFileSync("claude", ["mcp", "list", "--json"], { stdio: "pipe", encoding: "utf-8" });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function claudeAlreadyRegistered() {
  const list = claudeListJson();
  if (list && typeof list === "object") {
    if (list.sinain) return true;
    if (Array.isArray(list)) return list.some((e) => e?.name === "sinain");
  }
  try {
    const out = execFileSync("claude", ["mcp", "list"], { stdio: "pipe", encoding: "utf-8" });
    return /\bsinain\b/.test(out);
  } catch {
    return false;
  }
}

function claudeRegister({ extraEnv = {} } = {}) {
  if (!ensureMcpServerDeps()) {
    throw new Error(`MCP server not built. Run: cd ${MCP_SERVER_DIR} && npm install`);
  }
  // Idempotent: remove first (no-op if absent), then add.
  try { execFileSync("claude", ["mcp", "remove", "sinain"], { stdio: "pipe" }); } catch { /* not registered */ }
  const env = { ...DEFAULT_ENV, ...extraEnv };
  const args = ["mcp", "add", "sinain", "--scope", "user"];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push("--", TSX_BIN, MCP_ENTRY);
  execFileSync("claude", args, { stdio: "pipe", env: { ...process.env, ...env } });
}

function claudeUnregister() {
  try { execFileSync("claude", ["mcp", "remove", "sinain"], { stdio: "pipe" }); } catch { /* idempotent */ }
}

// ── Backend: Codex (CLI-managed via `codex mcp`) ────────────────────────────

function codexAlreadyRegistered() {
  try {
    const out = execFileSync("codex", ["mcp", "list"], { stdio: "pipe", encoding: "utf-8" });
    return /\bsinain\b/.test(out);
  } catch {
    return false;
  }
}

function codexRegister() {
  if (!ensureMcpServerDeps()) {
    throw new Error(`MCP server not built. Run: cd ${MCP_SERVER_DIR} && npm install`);
  }
  try { execFileSync("codex", ["mcp", "remove", "sinain"], { stdio: "pipe" }); } catch { /* not registered */ }
  const args = ["mcp", "add", "sinain"];
  for (const [k, v] of Object.entries(DEFAULT_ENV)) args.push("--env", `${k}=${v}`);
  args.push("--", TSX_BIN, MCP_ENTRY);
  execFileSync("codex", args, { stdio: "pipe" });
}

function codexUnregister() {
  try { execFileSync("codex", ["mcp", "remove", "sinain"], { stdio: "pipe" }); } catch { /* idempotent */ }
}

// ── Backend: JSON-config agents (Claude Desktop, Cursor, Junie) ─────────────
//
// All three use the same `mcpServers` object shape. The only thing that
// varies is the file path. Read-merge-write keeps untouched entries intact.

function jsonConfigPath(agentId) {
  switch (agentId) {
    case "claude-desktop":
      if (IS_MAC) return path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (IS_WINDOWS) return path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return path.join(HOME, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return path.join(HOME, ".cursor", "mcp.json");
    case "junie":
      return path.join(HOME, ".junie", "mcp", "mcp.json");
    default:
      throw new Error(`Unknown JSON-config agent: ${agentId}`);
  }
}

function jsonAlreadyRegistered(agentId) {
  const file = jsonConfigPath(agentId);
  if (!fs.existsSync(file)) return false;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf-8"));
    return !!json?.mcpServers?.sinain;
  } catch {
    return false;
  }
}

function jsonRegister(agentId) {
  if (!ensureMcpServerDeps()) {
    throw new Error(`MCP server not built. Run: cd ${MCP_SERVER_DIR} && npm install`);
  }
  const file = jsonConfigPath(agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf-8")) || {};
    } catch (err) {
      throw new Error(`Existing config at ${file} is not valid JSON: ${err.message}`);
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.sinain = mcpServerPayload();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

function jsonUnregister(agentId) {
  const file = jsonConfigPath(agentId);
  if (!fs.existsSync(file)) return;
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return; }
  if (config?.mcpServers?.sinain) {
    delete config.mcpServers.sinain;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  }
}

// ── Backend: Goose (YAML, hand-rolled splice with snippet fallback) ─────────
//
// Goose's config is YAML and we don't want a YAML dep just for this site.
// Strategy: detect a `sinain:` block under `extensions:` via line scanning;
// if present, splice replace; if absent, append. On any structural surprise,
// abort the write and return a printable snippet for the user to paste.

const GOOSE_CONFIG = path.join(HOME, ".config", "goose", "config.yaml");

function gooseSnippet() {
  return [
    "extensions:",
    "  sinain:",
    "    enabled: true",
    `    cmd: "${TSX_BIN}"`,
    `    args: ["${MCP_ENTRY}"]`,
    "    envs:",
    `      SINAIN_CORE_URL: "${DEFAULT_ENV.SINAIN_CORE_URL}"`,
    `      SINAIN_WORKSPACE: "${DEFAULT_ENV.SINAIN_WORKSPACE}"`,
  ].join("\n");
}

function gooseAlreadyRegistered() {
  if (!fs.existsSync(GOOSE_CONFIG)) return false;
  const content = fs.readFileSync(GOOSE_CONFIG, "utf-8");
  return /^\s+sinain:/m.test(content);
}

function gooseRegister() {
  if (!ensureMcpServerDeps()) {
    throw new Error(`MCP server not built. Run: cd ${MCP_SERVER_DIR} && npm install`);
  }
  fs.mkdirSync(path.dirname(GOOSE_CONFIG), { recursive: true });
  const exists = fs.existsSync(GOOSE_CONFIG);
  const content = exists ? fs.readFileSync(GOOSE_CONFIG, "utf-8") : "";

  // If the file is empty or only has top-level keys we recognise as safe to
  // append to, we add the extensions block fresh.
  if (!exists || !content.trim()) {
    fs.writeFileSync(GOOSE_CONFIG, gooseSnippet() + "\n");
    return { ok: true };
  }

  const hasExtensions = /^extensions:/m.test(content);
  const hasSinain = /^\s+sinain:/m.test(content);

  if (!hasExtensions) {
    const sep = content.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(GOOSE_CONFIG, content + sep + "\n" + gooseSnippet() + "\n");
    return { ok: true };
  }

  if (!hasSinain) {
    // Insert `sinain:` block right after the `extensions:` line.
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => /^extensions:/.test(l));
    const block = gooseSnippet().split("\n").slice(1); // drop the `extensions:` header
    lines.splice(idx + 1, 0, ...block);
    fs.writeFileSync(GOOSE_CONFIG, lines.join("\n"));
    return { ok: true };
  }

  // Sinain entry already exists — replace it. We replace the `sinain:` block
  // and every immediately-following line that's deeper-indented, stopping at
  // the next sibling key or end of file.
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^\s+sinain:/.test(l));
  if (start === -1) return { ok: false, reason: "structural-mismatch", snippet: gooseSnippet() };
  const indentMatch = lines[start].match(/^(\s+)/);
  const baseIndent = indentMatch ? indentMatch[1].length : 2;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") { end++; continue; }
    const m = line.match(/^(\s*)/);
    if ((m ? m[1].length : 0) <= baseIndent) break;
    end++;
  }
  const replacement = gooseSnippet().split("\n").slice(1); // drop `extensions:` header
  // re-indent replacement to baseIndent
  const reindented = replacement.map((l) => l.replace(/^ {2}/, " ".repeat(baseIndent)));
  lines.splice(start, end - start, ...reindented);
  fs.writeFileSync(GOOSE_CONFIG, lines.join("\n"));
  return { ok: true };
}

function gooseUnregister() {
  if (!fs.existsSync(GOOSE_CONFIG)) return;
  const content = fs.readFileSync(GOOSE_CONFIG, "utf-8");
  if (!/^\s+sinain:/m.test(content)) return;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^\s+sinain:/.test(l));
  if (start === -1) return;
  const baseIndent = (lines[start].match(/^(\s+)/)?.[1].length) || 2;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") { end++; continue; }
    if ((line.match(/^(\s*)/)?.[1].length || 0) <= baseIndent) break;
    end++;
  }
  lines.splice(start, end - start);
  fs.writeFileSync(GOOSE_CONFIG, lines.join("\n"));
}

// ── Agent registry ──────────────────────────────────────────────────────────

const AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    detect: () => cmdExists("claude"),
    isRegistered: claudeAlreadyRegistered,
    register: (opts) => claudeRegister(opts),
    unregister: claudeUnregister,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    detect: () => fs.existsSync(path.dirname(jsonConfigPath("claude-desktop"))),
    isRegistered: () => jsonAlreadyRegistered("claude-desktop"),
    register: () => jsonRegister("claude-desktop"),
    unregister: () => jsonUnregister("claude-desktop"),
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: () => cmdExists("cursor") || fs.existsSync(path.join(HOME, ".cursor")),
    isRegistered: () => jsonAlreadyRegistered("cursor"),
    register: () => jsonRegister("cursor"),
    unregister: () => jsonUnregister("cursor"),
  },
  {
    id: "codex",
    label: "Codex",
    detect: () => cmdExists("codex"),
    isRegistered: codexAlreadyRegistered,
    register: codexRegister,
    unregister: codexUnregister,
  },
  {
    id: "goose",
    label: "Goose",
    detect: () => cmdExists("goose") || fs.existsSync(GOOSE_CONFIG),
    isRegistered: gooseAlreadyRegistered,
    register: gooseRegister,
    unregister: gooseUnregister,
  },
  {
    id: "junie",
    label: "Junie",
    detect: () => cmdExists("junie") || fs.existsSync(path.join(HOME, ".junie")),
    isRegistered: () => jsonAlreadyRegistered("junie"),
    register: () => jsonRegister("junie"),
    unregister: () => jsonUnregister("junie"),
  },
];

function findAgent(id) {
  return AGENTS.find((a) => a.id === id);
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function detectMcpAgents() {
  return AGENTS.map((a) => {
    const present = !!a.detect();
    let alreadyRegistered = false;
    if (present) {
      try { alreadyRegistered = !!a.isRegistered(); } catch { /* ignore */ }
    }
    return { id: a.id, label: a.label, present, alreadyRegistered };
  });
}

export async function registerSinainMcp(agentId, opts = {}) {
  const a = findAgent(agentId);
  if (!a) throw new Error(`Unknown agent: ${agentId}`);
  await a.register(opts);
}

export async function unregisterSinainMcp(agentId) {
  const a = findAgent(agentId);
  if (!a) throw new Error(`Unknown agent: ${agentId}`);
  await a.unregister();
}

// ── Wizard step ─────────────────────────────────────────────────────────────

export async function stepMcpInstall(_existing, label = "MCP agents") {
  p.log.step(label);

  if (!mcpServerReady()) {
    const s = p.spinner();
    s.start("Preparing sinain MCP server...");
    const ok = ensureMcpServerDeps();
    s.stop(ok ? c.green("MCP server ready.") : c.yellow("MCP server deps not installed."));
    if (!ok) {
      p.note(
        `Could not install dependencies for the bundled MCP server.\nRun manually: cd ${MCP_SERVER_DIR} && npm install`,
        "MCP server",
      );
      return;
    }
  }

  const detectSpinner = p.spinner();
  detectSpinner.start("Detecting MCP-aware agents...");
  const agents = await detectMcpAgents();
  detectSpinner.stop(c.green("Detection done."));

  const detected = agents.filter((a) => a.present);
  if (detected.length === 0) {
    p.note(
      "No MCP-aware agents detected on this machine.\nInstall Claude Code, Cursor, Codex, Goose, or Junie first.\nThen re-run: npx @geravant/sinain mcp install",
      "Skipped",
    );
    return;
  }

  // Status summary
  const summary = detected
    .map((a) => `${a.label}: ${a.alreadyRegistered ? c.dim("registered") : c.green("detected")}`)
    .join("\n");
  p.note(summary, "Agents found");

  // Multi-select: pre-check unregistered detected agents
  const choice = guard(await p.multiselect({
    message: "Register sinain MCP for:",
    options: detected.map((a) => ({
      value: a.id,
      label: a.label,
      hint: a.alreadyRegistered ? "already registered (re-register to refresh paths)" : undefined,
    })),
    initialValues: detected.filter((a) => !a.alreadyRegistered).map((a) => a.id),
    required: false,
  }));

  if (!choice || choice.length === 0) {
    p.log.info("No agents selected — skipping MCP registration.");
    return;
  }

  for (const id of choice) {
    const a = findAgent(id);
    const s = p.spinner();
    s.start(`Registering for ${a.label}...`);
    try {
      await a.register();
      s.stop(c.green(`${a.label}: registered.`));
    } catch (err) {
      s.stop(c.yellow(`${a.label}: failed — ${err.message}`));
      if (id === "goose") {
        p.note(`Paste this into ${GOOSE_CONFIG}:\n\n${gooseSnippet()}`, "Goose snippet");
      }
    }
  }

  // Bonus: alternate Claude config dir (pclaude / CLAUDE_CONFIG_DIR)
  if (process.env.CLAUDE_CONFIG_DIR && choice.includes("claude")) {
    const altDir = process.env.CLAUDE_CONFIG_DIR;
    const alsoRegister = guard(await p.confirm({
      message: `Also register sinain for CLAUDE_CONFIG_DIR=${altDir}?`,
      initialValue: true,
    }));
    if (alsoRegister) {
      const s = p.spinner();
      s.start(`Registering for Claude (${altDir})...`);
      try {
        const env = { ...process.env, CLAUDE_CONFIG_DIR: altDir };
        const args = ["mcp", "remove", "sinain"];
        try { execFileSync("claude", args, { stdio: "pipe", env }); } catch { /* not registered */ }
        const addArgs = ["mcp", "add", "sinain", "--scope", "user"];
        for (const [k, v] of Object.entries(DEFAULT_ENV)) addArgs.push("--env", `${k}=${v}`);
        addArgs.push("--", TSX_BIN, MCP_ENTRY);
        execFileSync("claude", addArgs, { stdio: "pipe", env });
        s.stop(c.green(`Claude (${altDir}): registered.`));
      } catch (err) {
        s.stop(c.yellow(`Alt config dir: failed — ${err.message}`));
      }
    }
  }
}

// ── Standalone CLI ──────────────────────────────────────────────────────────

export async function runMcpCli(sub, args = []) {
  switch (sub) {
    case "install":
      return cliInstall(args);
    case "list":
      return cliList();
    case "remove":
      return cliRemove(args);
    default:
      printMcpUsage();
      process.exit(sub ? 1 : 0);
  }
}

async function cliInstall(args) {
  const all = args.includes("--all");
  const agentArg = args.find((a) => a.startsWith("--agent="));
  const agentId = agentArg ? agentArg.slice("--agent=".length) : null;

  if (agentId) {
    const a = findAgent(agentId);
    if (!a) { console.error(c.red(`Unknown agent: ${agentId}`)); process.exit(1); }
    if (!a.detect()) { console.error(c.yellow(`${a.label} not detected on this machine.`)); process.exit(1); }
    try {
      await a.register();
      console.log(c.green(`✓ ${a.label}: registered.`));
    } catch (err) {
      console.error(c.red(`✗ ${a.label}: ${err.message}`));
      if (agentId === "goose") console.log(`\nPaste this into ${GOOSE_CONFIG}:\n\n${gooseSnippet()}`);
      process.exit(1);
    }
    return;
  }

  if (all) {
    if (!mcpServerReady() && !ensureMcpServerDeps()) {
      console.error(c.red(`MCP server deps not installed. Run: cd ${MCP_SERVER_DIR} && npm install`));
      process.exit(1);
    }
    const agents = await detectMcpAgents();
    const detected = agents.filter((a) => a.present);
    if (detected.length === 0) {
      console.log(c.yellow("No MCP-aware agents detected."));
      return;
    }
    for (const a of detected) {
      const backend = findAgent(a.id);
      try {
        await backend.register();
        console.log(c.green(`✓ ${a.label}: registered.`));
      } catch (err) {
        console.error(c.yellow(`! ${a.label}: ${err.message}`));
      }
    }
    return;
  }

  // Interactive
  await stepMcpInstall({}, "MCP agents");
}

async function cliList() {
  const agents = await detectMcpAgents();
  console.log();
  console.log(c.bold("  Sinain MCP — agent status"));
  console.log();
  for (const a of agents) {
    const present = a.present ? c.green("present") : c.dim("absent ");
    const reg = a.alreadyRegistered ? c.green("✓ registered") : (a.present ? c.dim("· not registered") : c.dim("·"));
    console.log(`    ${present}  ${a.label.padEnd(18)}  ${reg}`);
  }
  console.log();
}

async function cliRemove(args) {
  const id = args[0];
  if (!id) { console.error(c.red("Usage: sinain mcp remove <agent>")); process.exit(1); }
  const a = findAgent(id);
  if (!a) { console.error(c.red(`Unknown agent: ${id}`)); process.exit(1); }
  try {
    await a.unregister();
    console.log(c.green(`✓ ${a.label}: removed.`));
  } catch (err) {
    console.error(c.red(`✗ ${a.label}: ${err.message}`));
    process.exit(1);
  }
}

function printMcpUsage() {
  console.log(`
sinain mcp — register the sinain MCP server with your agents

Usage:
  sinain mcp install                Interactive install (multi-select)
  sinain mcp install --all          Register for every detected agent
  sinain mcp install --agent=<id>   Register for one agent
  sinain mcp list                   Show agent status
  sinain mcp remove <agent>         Unregister sinain from <agent>

Supported agent IDs:
  claude, claude-desktop, cursor, codex, goose, junie
`);
}
