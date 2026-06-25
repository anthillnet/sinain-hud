#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, IncomingMessage } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SINAIN_CORE_URL = process.env.SINAIN_CORE_URL || "http://localhost:9500";
const WORKSPACE = (process.env.SINAIN_WORKSPACE || "~/.openclaw/workspace").replace(/^~/, os.homedir());
const MEMORY_DIR = resolve(WORKSPACE, "memory");

// Transport selection:
//   stdio (default) — for local MCP clients like Claude Desktop.
//   http            — Streamable HTTP, for remote clients like ChatGPT, which
//                     only accept remote MCP connectors over HTTPS (tunnel a
//                     local http port with ngrok / Cloudflare / OpenAI tunnel).
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 9510);

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

// A single McpServer can only bind to ONE transport, so we build a fresh
// instance per connection. stdio uses one; the HTTP transport mints one per
// session (remote clients run initialize/list/call across separate requests).
function buildServer() {
const server = new McpServer({
  name: "sinain-mcp-server",
  version: "0.2.0",
});

// 1. sinain_get_escalation — escalation loop contract (run.sh prompts this)
server.tool(
  "sinain_get_escalation",
  "Get the current pending escalation from sinain-core",
  {},
  { title: "Get pending escalation", readOnlyHint: true, openWorldHint: false },
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
  { title: "Respond to escalation", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
  { title: "Get current context", readOnlyHint: true, openWorldHint: false },
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

// 3b. sinain_roi — fetch the seed the user just queued by selecting a screen
//     region in the HUD ("Ask Claude" on a ROI). The deep-link that opens this
//     chat only carries a pointer ("call sinain_roi and follow it"); the real
//     payload (composed context + optional cropped screenshot) rides this tool,
//     so it never hits the URL length cap or the file-attach modal.
server.tool(
  "sinain_roi",
  "Fetch the pending region-of-interest (ROI) seed the user queued from the sinain HUD: the composed screen context for the region they selected, plus a cropped screenshot when available. Call this first when asked to 'follow the ROI / seed instructions', passing the seed id from that request, then do what the seed says.",
  {
    id: z.string().optional()
      .describe("The ROI seed id from the request that opened this chat. Omit to get the most recent pending seed."),
  },
  { title: "Fetch ROI seed", readOnlyHint: true, openWorldHint: false },
  async ({ id }) => {
    try {
      const qs = id ? `?id=${encodeURIComponent(id)}` : "";
      const data = await coreRequest("GET", `/roi/pending${qs}`);
      if (!data || data.ok === false || !data.seed) {
        return textResult(
          id
            ? `No ROI seed found for id "${id}" — it may have expired or already been consumed.`
            : "No pending ROI seed — the user hasn't queued a region from the HUD (or it expired).",
        );
      }
      const content: any[] = [];
      const header = data.id || data.regionId ? `[ROI seed id=${data.id ?? "?"} region=${data.regionId ?? "?"}]\n\n` : "";
      const text = stripPrivateTags(String(data.seed.text || ""));
      content.push({ type: "text" as const, text: header + (text || "(empty seed)") });
      // Cropped ROI screenshot, if the capture pipeline attached one.
      if (data.seed.image) {
        content.push({
          type: "image" as const,
          data: data.seed.image, // base64, no data: prefix
          mimeType: data.seed.imageMimeType || "image/jpeg",
        });
      }
      return { content };
    } catch (err: any) {
      return textResult(`Error fetching ROI seed: ${err.message}`);
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
  { title: "Query long-term memory", readOnlyHint: true, openWorldHint: false },
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
  { title: "Store to long-term memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
  { title: "Notify on the HUD", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
  { title: "Check sinain health", readOnlyHint: true, openWorldHint: false },
  async () => {
    try {
      const data = await coreRequest("GET", "/health");
      return textResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      return textResult(`Error checking health: ${err.message}`);
    }
  },
);

  return server;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Read and JSON-parse a Node request body (Streamable HTTP needs the parsed
// body passed alongside req/res).
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function startHttp() {
  // Stateful mode: remote clients (ChatGPT) run the full initialize → tools/list
  // → tools/call lifecycle across SEPARATE HTTP requests, so the server must
  // correlate them by session id. We mint a session on initialize, return it in
  // the mcp-session-id header, and route subsequent requests to that transport.
  const { randomUUID } = await import("node:crypto");
  const transports: Record<string, InstanceType<typeof StreamableHTTPServerTransport>> = {};

  const httpServer = createServer(async (req, res) => {
    const pathname = req.url ? new URL(req.url, "http://localhost").pathname.replace(/\/$/, "") : "";
    if (pathname !== "/mcp") {
      res.writeHead(404).end("Not found — POST MCP requests to /mcp");
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.error(`[http] ${req.method} /mcp session=${sessionId ?? "-"} host=${req.headers.host}`);
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        // No session yet — must be the initialize request. Mint a transport.
        const isInit = body && typeof body === "object" && (body as any).method === "initialize";
        if (sessionId || !isInit) {
          res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first" }, id: null }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport!; },
        });
        transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
        await buildServer().connect(transport); // fresh server per session
      }
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      console.error("[http] handleRequest threw:", err?.stack || err);
      if (!res.headersSent) res.writeHead(400).end(`Bad request: ${err.message}`);
    }
  });

  httpServer.listen(MCP_HTTP_PORT, () => {
    console.error(
      `sinain-mcp-server (http) listening on http://localhost:${MCP_HTTP_PORT}/mcp ` +
        `(core=${SINAIN_CORE_URL}) — tunnel this port over HTTPS for ChatGPT`,
    );
  });
}

async function main() {
  if (MCP_TRANSPORT === "http") {
    await startHttp();
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error(`sinain-mcp-server (stdio) started (core=${SINAIN_CORE_URL}, workspace=${WORKSPACE})`);
}

main().catch(console.error);
