#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SINAIN_CORE_URL = process.env.SINAIN_CORE_URL || "http://localhost:9500";
const WORKSPACE = (process.env.SINAIN_WORKSPACE || "~/.openclaw/workspace").replace(/^~/, os.homedir());
const MEMORY_DIR = resolve(WORKSPACE, "memory");

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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Server — 7 tools covering the two sinain scenarios:
//   A. sinain's own agents (chat/terminal threads + the escalation loop):
//      get_escalation/respond (loop contract), context, memory_query.
//   B. an external agent using sinain as its memory layer
//      (query/store): memory_query, memory_store, notify, health.
// There is deliberately no ask-user tool — the user converses through the
// thread's chat or terminal; the conversation IS the question channel.
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "sinain-mcp-server",
  version: "0.2.0",
});

// 1. sinain_get_escalation — escalation loop contract (run.sh prompts this)
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

// 2. sinain_respond — escalation loop contract
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

// 3. sinain_context — the situational "whoami": current digest + context
//    window (screen OCR, audio transcripts, app history) in one call.
server.tool(
  "sinain_context",
  "Get the user's current situation: the agent digest (one-paragraph summary) plus the full context window (screen OCR, audio transcripts, app history)",
  {},
  async () => {
    try {
      const [digest, context] = await Promise.all([
        coreRequest("GET", "/agent/digest").catch(() => null),
        coreRequest("GET", "/agent/context").catch(() => null),
      ]);
      if (!digest && !context) {
        return textResult("sinain-core unreachable — no context available");
      }
      const parts: string[] = [];
      if (digest) parts.push(`## Digest\n${JSON.stringify(digest, null, 2)}`);
      if (context) parts.push(`## Context window\n${JSON.stringify(context, null, 2)}`);
      return textResult(stripPrivateTags(parts.join("\n\n")));
    } catch (err: any) {
      return textResult(`Error fetching context: ${err.message}`);
    }
  },
);

// 4. sinain_memory_query — hybrid retrieval over the knowledge graph
//    (merges the local + workspace triplestores via sinain-core).
server.tool(
  "sinain_memory_query",
  "Query sinain's long-term memory (knowledge graph). Pass entities/keywords to retrieve related facts; set include_document to also get the portable knowledge document (playbook + top facts)",
  {
    entities: z.array(z.string()).optional().default([])
      .describe("Entities or keywords to retrieve facts about, e.g. ['german','grammar']"),
    max_facts: z.number().optional().default(8),
    include_document: z.boolean().optional().default(false)
      .describe("Also include the portable knowledge document (playbook + top facts)"),
  },
  async ({ entities, max_facts, include_document }) => {
    const parts: string[] = [];
    if (entities.length > 0) {
      try {
        const params = new URLSearchParams({
          entities: entities.join(","),
          max: String(max_facts),
        });
        const data = await coreRequest("GET", `/knowledge/facts?${params}`);
        if (data.ok && data.facts) parts.push(stripPrivateTags(data.facts));
      } catch (err: any) {
        parts.push(`Error querying graph: ${err.message}`);
      }
    }
    if (include_document || entities.length === 0) {
      try {
        const data = await coreRequest("GET", "/knowledge");
        if (data.ok && data.content) {
          parts.push(stripPrivateTags(data.content));
        }
      } catch {
        // sinain-core unreachable — fall back to the workspace doc on disk
        const docPath = resolve(MEMORY_DIR, "sinain-knowledge.md");
        if (existsSync(docPath)) {
          parts.push(stripPrivateTags(readFileSync(docPath, "utf-8")));
        }
      }
    }
    return textResult(parts.length > 0 ? parts.join("\n\n") : "No matching knowledge found");
  },
);

// 5. sinain_memory_store — write facts into the knowledge graph. The
//    deterministic integrator handles dedup, so storing is idempotent-ish.
server.tool(
  "sinain_memory_store",
  "Store facts in sinain's long-term memory (knowledge graph). Each fact is an entity/attribute/value triple; duplicates are deduplicated automatically",
  {
    facts: z.array(z.object({
      entity: z.string().describe("Entity the fact is about, kebab-case, e.g. 'sinain-hud' or 'igor'"),
      attribute: z.string().describe("Attribute name, e.g. 'prefers', 'deadline', 'status'"),
      value: z.string().describe("The fact content"),
      confidence: z.number().optional().describe("0..1, default 0.7"),
      domain: z.string().optional().describe("Optional domain tag, e.g. 'work', 'german'"),
    })).min(1),
  },
  async ({ facts }) => {
    try {
      const data = await coreRequest("POST", "/knowledge/import", { facts });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error storing facts: ${err.message}`);
    }
  },
);

// 6. sinain_notify — the one outward push channel: a message on the HUD
//    feed. Replies in a thread happen in the conversation itself, not here.
server.tool(
  "sinain_notify",
  "Show a message on the user's HUD feed (the invisible overlay). Use for proactive notices; conversation replies belong in the conversation",
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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`sinain-mcp-server started (core=${SINAIN_CORE_URL}, workspace=${WORKSPACE})`);
}

main().catch(console.error);
