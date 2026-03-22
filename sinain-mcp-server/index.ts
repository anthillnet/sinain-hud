#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SINAIN_CORE_URL = process.env.SINAIN_CORE_URL || "http://localhost:9500";
const WORKSPACE = (process.env.SINAIN_WORKSPACE || "~/.openclaw/workspace").replace(/^~/, os.homedir());
const MEMORY_DIR = resolve(WORKSPACE, "memory");
const MODULES_DIR = resolve(WORKSPACE, "modules");

const SCRIPTS_CANDIDATES = [
  resolve(WORKSPACE, "sinain-memory"),
  resolve(import.meta.dirname || ".", "..", "sinain-hud-plugin", "sinain-memory"),
];
const SCRIPTS_DIR = SCRIPTS_CANDIDATES.find((d) => existsSync(d)) || SCRIPTS_CANDIDATES[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrivateTags(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/g, "[REDACTED]");
}

async function coreRequest(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${SINAIN_CORE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const json = await res.json();
  return json;
}

function runScript(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`Script failed: ${err.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "sinain-mcp-server",
  version: "0.1.0",
});

// 1. sinain_get_escalation
server.tool(
  "sinain_get_escalation",
  "Get the current pending escalation from sinain-core",
  {},
  async () => {
    try {
      const data = await coreRequest("GET", "/escalation/pending");
      if (!data || (data.status && data.status === "none")) {
        return textResult("No pending escalation");
      }
      return textResult(stripPrivateTags(JSON.stringify(data, null, 2)));
    } catch (err: any) {
      return textResult(`Error fetching escalation: ${err.message}`);
    }
  },
);

// 2. sinain_respond
server.tool(
  "sinain_respond",
  "Respond to a pending escalation",
  { id: z.string(), response: z.string() },
  async ({ id, response }) => {
    try {
      const data = await coreRequest("POST", "/escalation/respond", { id, response });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error responding to escalation: ${err.message}`);
    }
  },
);

// 3. sinain_get_context
server.tool(
  "sinain_get_context",
  "Get the current agent context window from sinain-core (screen + audio + feed)",
  {},
  async () => {
    try {
      const data = await coreRequest("GET", "/agent/context");
      return textResult(stripPrivateTags(JSON.stringify(data, null, 2)));
    } catch (err: any) {
      return textResult(`Error fetching context: ${err.message}`);
    }
  },
);

// 4. sinain_get_digest
server.tool(
  "sinain_get_digest",
  "Get the latest agent digest from sinain-core",
  {},
  async () => {
    try {
      const data = await coreRequest("GET", "/agent/digest");
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error fetching digest: ${err.message}`);
    }
  },
);

// 5. sinain_get_feedback
server.tool(
  "sinain_get_feedback",
  "Get recent learning feedback entries",
  { limit: z.number().optional().default(20) },
  async ({ limit }) => {
    try {
      const data = await coreRequest("GET", `/learning/feedback?limit=${limit}`);
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error fetching feedback: ${err.message}`);
    }
  },
);

// 6. sinain_post_feed
// 6b. sinain_spawn
server.tool(
  "sinain_spawn",
  "Spawn a background agent task via sinain-core",
  {
    task: z.string(),
    label: z.string().optional().default("background-task"),
  },
  async ({ task, label }) => {
    try {
      const data = await coreRequest("POST", "/spawn", { text: task, label });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error spawning task: ${err.message}`);
    }
  },
);

server.tool(
  "sinain_post_feed",
  "Post a message to the sinain-core HUD feed",
  {
    text: z.string(),
    priority: z.enum(["normal", "high", "urgent"]).optional().default("normal"),
  },
  async ({ text, priority }) => {
    try {
      const data = await coreRequest("POST", "/feed", { text, priority });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error posting to feed: ${err.message}`);
    }
  },
);

// 7. sinain_health
server.tool(
  "sinain_health",
  "Check sinain-core health status",
  {},
  async () => {
    try {
      const data = await coreRequest("GET", "/health");
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error checking health: ${err.message}`);
    }
  },
);

// 8. sinain_get_knowledge
server.tool(
  "sinain_get_knowledge",
  "Get the portable knowledge document (playbook + long-term facts + recent sessions)",
  {},
  async () => {
    try {
      // Read pre-rendered knowledge doc (fast, no subprocess)
      const docPath = resolve(MEMORY_DIR, "sinain-knowledge.md");
      if (existsSync(docPath)) {
        const content = readFileSync(docPath, "utf-8");
        return textResult(stripPrivateTags(content));
      }
      // Fallback: read playbook directly
      const playbookPath = resolve(MEMORY_DIR, "sinain-playbook.md");
      if (existsSync(playbookPath)) {
        return textResult(stripPrivateTags(readFileSync(playbookPath, "utf-8")));
      }
      return textResult("No knowledge document available yet");
    } catch (err: any) {
      return textResult(`Error reading knowledge: ${err.message}`);
    }
  },
);

// 8b. sinain_knowledge_query (graph query — entity-based lookup)
server.tool(
  "sinain_knowledge_query",
  "Query the knowledge graph for facts about specific entities/domains",
  {
    entities: z.array(z.string()).optional().default([]),
    max_facts: z.number().optional().default(5),
  },
  async ({ entities, max_facts }) => {
    try {
      const dbPath = resolve(MEMORY_DIR, "knowledge-graph.db");
      const scriptPath = resolve(SCRIPTS_DIR, "graph_query.py");
      const args = [scriptPath, "--db", dbPath, "--max-facts", String(max_facts)];
      if (entities.length > 0) {
        args.push("--entities", JSON.stringify(entities));
      }
      const output = await runScript(args);
      return textResult(stripPrivateTags(output));
    } catch (err: any) {
      return textResult(`Error querying graph: ${err.message}`);
    }
  },
);

// 8c. sinain_distill_session
server.tool(
  "sinain_distill_session",
  "Distill the current session into knowledge (playbook updates + graph facts)",
  {
    session_summary: z.string().optional().default("Bare agent session distillation"),
  },
  async ({ session_summary }) => {
    const results: string[] = [];

    try {
      // Fetch feed items from sinain-core
      const coreUrl = process.env.SINAIN_CORE_URL || "http://localhost:9500";
      const feedResp = await fetch(`${coreUrl}/feed?after=0`).then(r => r.json());
      const historyResp = await fetch(`${coreUrl}/agent/history?limit=10`).then(r => r.json());

      const feedItems = (feedResp as any).messages ?? [];
      const agentHistory = (historyResp as any).results ?? [];

      if (feedItems.length < 3) {
        return textResult("Not enough feed items to distill (need >3)");
      }

      // Step 1: Distill
      const transcript = JSON.stringify([...feedItems, ...agentHistory].slice(0, 100));
      const meta = JSON.stringify({ ts: new Date().toISOString(), sessionKey: session_summary });

      const distillOutput = await runScript([
        resolve(SCRIPTS_DIR, "session_distiller.py"),
        "--memory-dir", MEMORY_DIR,
        "--transcript", transcript,
        "--session-meta", meta,
      ], 30_000);
      results.push(`[session_distiller] ${distillOutput.trim().slice(0, 500)}`);

      const digest = JSON.parse(distillOutput.trim());
      if (digest.isEmpty || digest.error) {
        return textResult(`Distillation skipped: ${digest.error || "empty session"}`);
      }

      // Step 2: Integrate
      const integrateOutput = await runScript([
        resolve(SCRIPTS_DIR, "knowledge_integrator.py"),
        "--memory-dir", MEMORY_DIR,
        "--digest", JSON.stringify(digest),
      ], 60_000);
      results.push(`[knowledge_integrator] ${integrateOutput.trim().slice(0, 500)}`);

      return textResult(stripPrivateTags(results.join("\n\n")));
    } catch (err: any) {
      return textResult(`Distillation error: ${err.message}`);
    }
  },
);

// 9. sinain_heartbeat_tick
server.tool(
  "sinain_heartbeat_tick",
  "Run the full heartbeat knowledge pipeline (signal analysis, insight synthesis, memory mining, playbook curation)",
  {
    session_summary: z.string().optional().default("Bare agent heartbeat tick"),
  },
  async ({ session_summary }) => {
    const results: string[] = [];
    const now = new Date().toISOString();

    // Step 1: git_backup.sh
    const gitBackupPath = resolve(SCRIPTS_DIR, "git_backup.sh");
    if (existsSync(gitBackupPath)) {
      try {
        const out = await new Promise<string>((res, rej) => {
          execFile("bash", [gitBackupPath, MEMORY_DIR], { timeout: 30_000 }, (err, stdout, stderr) => {
            if (err) rej(new Error(`git_backup failed: ${err.message}\n${stderr}`));
            else res(stdout);
          });
        });
        results.push(`[git_backup] ${out.trim() || "OK"}`);
      } catch (err: any) {
        results.push(`[git_backup] FAILED: ${err.message}`);
      }
    }

    // Step 2: signal_analyzer.py
    try {
      const out = await runScript([
        resolve(SCRIPTS_DIR, "signal_analyzer.py"),
        "--memory-dir", MEMORY_DIR,
        "--session-summary", session_summary,
        "--current-time", now,
      ]);
      results.push(`[signal_analyzer] ${out.trim() || "OK"}`);
    } catch (err: any) {
      results.push(`[signal_analyzer] FAILED: ${err.message}`);
    }

    // Step 3: insight_synthesizer.py
    try {
      const out = await runScript([
        resolve(SCRIPTS_DIR, "insight_synthesizer.py"),
        "--memory-dir", MEMORY_DIR,
        "--session-summary", session_summary,
      ]);
      results.push(`[insight_synthesizer] ${out.trim() || "OK"}`);
    } catch (err: any) {
      results.push(`[insight_synthesizer] FAILED: ${err.message}`);
    }

    // Step 4: memory_miner.py
    try {
      const out = await runScript([
        resolve(SCRIPTS_DIR, "memory_miner.py"),
        "--memory-dir", MEMORY_DIR,
      ]);
      results.push(`[memory_miner] ${out.trim() || "OK"}`);
    } catch (err: any) {
      results.push(`[memory_miner] FAILED: ${err.message}`);
    }

    // Step 5: playbook_curator.py
    try {
      const out = await runScript([
        resolve(SCRIPTS_DIR, "playbook_curator.py"),
        "--memory-dir", MEMORY_DIR,
        "--session-summary", session_summary,
      ]);
      results.push(`[playbook_curator] ${out.trim() || "OK"}`);
    } catch (err: any) {
      results.push(`[playbook_curator] FAILED: ${err.message}`);
    }

    return textResult(stripPrivateTags(results.join("\n\n")));
  },
);

// 10. sinain_user_command
server.tool(
  "sinain_user_command",
  "Queue a user command to augment the next escalation context (forces escalation on next agent tick)",
  { text: z.string().describe("The command text to inject into the next escalation") },
  async ({ text }) => {
    try {
      const data = await coreRequest("POST", "/user/command", { text });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error queuing user command: ${err.message}`);
    }
  },
);

// 11. sinain_module_guidance
server.tool(
  "sinain_module_guidance",
  "Read guidance from all active modules in the workspace",
  {},
  async () => {
    try {
      const registryPath = resolve(MODULES_DIR, "module-registry.json");
      if (!existsSync(registryPath)) {
        return textResult("No modules configured");
      }

      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      const modules: Array<{ name: string; active?: boolean }> = Array.isArray(registry)
        ? registry
        : registry.modules || [];

      const parts: string[] = [];
      for (const mod of modules) {
        if (mod.active === false) continue;
        const guidancePath = resolve(MODULES_DIR, mod.name, "guidance.md");
        if (existsSync(guidancePath)) {
          const content = readFileSync(guidancePath, "utf-8");
          parts.push(`## ${mod.name}\n\n${content}`);
        }
      }

      if (parts.length === 0) {
        return textResult("No module guidance files found");
      }
      return textResult(stripPrivateTags(parts.join("\n\n---\n\n")));
    } catch (err: any) {
      return textResult(`Error reading module guidance: ${err.message}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`sinain-mcp-server started (core=${SINAIN_CORE_URL}, workspace=${WORKSPACE})`);
}

main().catch(console.error);
