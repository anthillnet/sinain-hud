/** Lean 8-tool surface for the sinain chat agent — port of sinain-chat-agent/tools.py.
 *
 * KEEP set: sinain_memory_query, sinain_context, sinain_memory_episodes,
 * sinain_memory_store, read_file, bash (read-only-sandboxed), grep, glob.
 * Each executor calls sinain-core HTTP / the local machine and emits contract
 * events (tool_call / tool_result) through a per-turn sink, exactly like the
 * Python SINK pattern — so the stream-parsing side never needs tool plumbing.
 *
 * Why so few: every tool's schema is prompt tokens on EVERY turn → slower TTFT.
 * Connectors (GSuite/Slack/Glean) come later via deferred MCP loading.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { glob as fsGlob } from "node:fs/promises";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

const CORE_URL = process.env.SINAIN_CORE_URL || "http://localhost:9500";
const MAX = 4000; // cap tool output so a huge payload can't blow up TTFT (the sinain_context lesson)

/** Per-turn event sink (set by the sidecar before each turn; chat is serialized). */
export type Sink = (ev: Record<string, unknown>) => void;
let sink: Sink | null = null;
export function setSink(s: Sink | null): void {
  sink = s;
}

async function get(path: string): Promise<string> {
  try {
    const res = await fetch(CORE_URL + path, { signal: AbortSignal.timeout(10_000) });
    return (await res.text()).slice(0, MAX);
  } catch (e) {
    return `[sinain-core unreachable at ${CORE_URL}: ${e instanceof Error ? e.message : e}]`;
  }
}

async function post(path: string, body: unknown): Promise<string> {
  try {
    const res = await fetch(CORE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.text()).slice(0, 2000);
  } catch (e) {
    return `[sinain-core unreachable at ${CORE_URL}: ${e instanceof Error ? e.message : e}]`;
  }
}

const BANNED = ["rm ", "rm -", "mkfs", "dd ", ":(){", "shutdown", "reboot", "> /dev", "sudo ", "chmod ", "mv "];

function bash(cmd: string): Promise<string> {
  if (BANNED.some((b) => cmd.includes(b))) {
    return Promise.resolve("[refused: potentially destructive command]");
  }
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-c", cmd], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve("[bash timeout 15s]");
      resolve((stdout + stderr).slice(0, MAX) || "[no output]");
    });
  });
}

/** Wrap an executor so every call emits the contract's tool_call/tool_result events. */
function traced<A>(name: string, run: (args: A) => Promise<string>): (args: A) => Promise<string> {
  return async (args: A) => {
    sink?.({ type: "tool_call", tool_name: name, tool_args: args as Record<string, unknown> });
    const result = await run(args);
    sink?.({ type: "tool_result", tool_name: name, tool_result: result.slice(0, 500) });
    return result;
  };
}

export function buildTools(): ToolSet {
  return {
    sinain_memory_query: tool({
      description: "Query the user's knowledge graph (facts/entities).",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().optional().default(8),
      }),
      execute: traced("sinain_memory_query", async ({ query, limit }) =>
        // /knowledge/query (NOT /knowledge/facts): the facts endpoint ignores `q`.
        get(`/knowledge/query?q=${encodeURIComponent(query)}&max=${limit ?? 8}`)),
    }),
    sinain_context: tool({
      description: "Get the user's current situation: digest + screen OCR/vision, audio, app history.",
      inputSchema: z.object({}),
      execute: traced("sinain_context", async () =>
        (await get("/agent/digest") + "\n---\n" + await get("/agent/context")).slice(0, MAX)),
    }),
    sinain_memory_episodes: tool({
      description:
        "Recall past observed activity as dated episodes (conversations, meetings, work sessions). " +
        "Use for 'what happened earlier / summarize that meeting' — set include_text for raw excerpts.",
      inputSchema: z.object({
        query: z.string().optional().default(""),
        since: z.string().optional().default("").describe("ISO timestamp, e.g. 2026-07-03T10:00"),
        limit: z.number().int().optional().default(20),
        include_text: z.boolean().optional().default(false),
      }),
      execute: traced("sinain_memory_episodes", async ({ query, since, limit, include_text }) =>
        get(`/memory/episodes?q=${encodeURIComponent(query ?? "")}&since=${encodeURIComponent(since ?? "")}` +
            `&limit=${limit ?? 20}&text=${include_text ? "1" : "0"}`)),
    }),
    sinain_memory_store: tool({
      description: "Save a fact/note to the user's long-term memory.",
      inputSchema: z.object({ text: z.string() }),
      execute: traced("sinain_memory_store", async ({ text }) => {
        // /knowledge/import expects the sinain export shape {"facts":[{entity,
        // attribute,value}]} — free text becomes one note triple the
        // deterministic integrator dedups + makes queryable.
        const txt = (text ?? "").trim();
        if (!txt) return JSON.stringify({ ok: false, error: "nothing to store" });
        return post("/knowledge/import", {
          facts: [{ entity: "user", attribute: "note", value: txt, confidence: 0.7 }],
        });
      }),
    }),
    read_file: tool({
      description: "Read a UTF-8 text file by absolute path.",
      inputSchema: z.object({ path: z.string() }),
      execute: traced("read_file", async ({ path }) => {
        try {
          return (await readFile(path, "utf-8")).slice(0, MAX);
        } catch (e) {
          return `[read_file error: ${e instanceof Error ? e.message : e}]`;
        }
      }),
    }),
    bash: tool({
      description: "Run a read-only shell command to orient on the machine.",
      inputSchema: z.object({ command: z.string() }),
      execute: traced("bash", async ({ command }) => bash(command ?? "")),
    }),
    grep: tool({
      description: "Search file contents for a pattern under a path.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().default("."),
      }),
      execute: traced("grep", async ({ pattern, path }) =>
        bash(`grep -rn -- ${JSON.stringify(pattern ?? "")} ${JSON.stringify(path ?? ".")} | head -50`)),
    }),
    glob: tool({
      description: "Find files matching a glob pattern.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: traced("glob", async ({ pattern }) => {
        try {
          const out: string[] = [];
          for await (const p of fsGlob(pattern ?? "")) {
            out.push(String(p));
            if (out.length >= 50) break;
          }
          return out.join("\n") || "[no matches]";
        } catch (e) {
          return `[glob error: ${e instanceof Error ? e.message : e}]`;
        }
      }),
    }),
  };
}
