#!/usr/bin/env node
// ACP man-in-the-middle: sits between an ACP client (JetBrains Air, Zed, …) and an
// ACP agent (claude-agent-acp, gemini, …), passing every JSON-RPC line through
// verbatim while teeing `session/request_permission` to sinain-core. The overlay
// and the editor dialog then race: first decision wins, the loser is cancelled —
// the editor via `$/cancel_request`, sinain by aborting the /agent/approve POST
// (sinain-core dismisses the card when the request socket closes).
//
// Usage (in the client's agent-server config):
//   node acp-proxy.mjs [--source <name>] -- <real-agent-command> [args...]
//
// The child inherits the environment plus SINAIN_ACP_PROXY=1, which tells
// sinain-bridge.mjs hooks inside the agent to skip their own blocking
// PermissionRequest approval (the proxy owns that lane here).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function fail(message) {
  process.stderr.write(`[sinain-acp-proxy] ${message}\n`);
  process.exit(2);
}

const sep = process.argv.indexOf("--");
if (sep < 0 || sep + 1 >= process.argv.length) {
  fail("usage: acp-proxy.mjs [--source <name>] -- <agent-command> [args...]");
}
const ownArgs = process.argv.slice(2, sep);
const sourceIndex = ownArgs.indexOf("--source");
const source = sourceIndex >= 0 && ownArgs[sourceIndex + 1] ? ownArgs[sourceIndex + 1] : "claude";
const command = process.argv[sep + 1];
const commandArgs = process.argv.slice(sep + 2);

const host = process.env.SINAIN_HOST ?? "127.0.0.1";
const port = process.env.SINAIN_PORT ?? "9500";
const approveUrl = `http://${host}:${port}/agent/approve`;
const APPROVE_TIMEOUT_MS = 150_000; // > sinain-core AGENT_APPROVE_TIMEOUT_MS (120s)

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SINAIN_ACP_PROXY: "1" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
child.on("error", (error) => fail(`failed to spawn agent: ${error.message}`));
process.stdin.on("end", () => child.stdin.end());

function writeClient(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function writeAgent(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}
function tryParse(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function isResponse(msg) {
  return msg.method === undefined && msg.id !== undefined
    && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"));
}

// sessionId → cwd (captured from session/new request/response pairs).
const sessionCwds = new Map();
// client→agent session/new request id → cwd, until the response names the session.
const newSessionRequests = new Map();
// agent→client session/request_permission id → race state.
const pendingPermissions = new Map();

function pickOption(options, behavior) {
  const kinds = behavior === "deny"
    ? ["reject_once", "reject_always"]
    : behavior === "always"
      ? ["allow_always", "allow_once"]
      : ["allow_once", "allow_always"];
  for (const kind of kinds) {
    const option = (options ?? []).find((o) => o?.kind === kind);
    if (option) return option.optionId;
  }
  return null;
}

function interceptPermission(msg) {
  const params = msg.params ?? {};
  const toolCall = params.toolCall ?? {};
  const entry = { abort: new AbortController(), settled: false };
  pendingPermissions.set(msg.id, entry);
  // Backstop so a lost response can't leak the entry forever.
  const sweep = setTimeout(() => pendingPermissions.delete(msg.id), 15 * 60_000);
  sweep.unref?.();

  const frame = {
    session_id: String(params.sessionId ?? "acp"),
    hook_event_name: "PermissionRequest",
    source,
    tool_name: toolCall?._meta?.claudeCode?.toolName ?? toolCall.title ?? toolCall.kind ?? "tool",
    tool_input: toolCall.rawInput,
    ...(sessionCwds.has(params.sessionId) ? { cwd: sessionCwds.get(params.sessionId) } : {}),
    acp_proxy: true,
    ts: Date.now(),
  };

  (async () => {
    const timer = setTimeout(() => entry.abort.abort(), APPROVE_TIMEOUT_MS);
    try {
      const response = await fetch(approveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
        signal: entry.abort.signal,
      });
      if (!response.ok) return;
      const body = await response.json();
      const behavior = body?.behavior;
      if (entry.settled || !["allow", "always", "deny"].includes(behavior)) return;
      const optionId = pickOption(params.options, behavior);
      if (optionId === null) return;
      entry.settled = true;
      // Retract the editor's dialog, then answer the agent on its behalf.
      writeClient({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: msg.id } });
      writeAgent({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId } } });
    } catch {
      // sinain-core unreachable or race lost — the editor dialog still governs.
    } finally {
      clearTimeout(timer);
    }
  })();
}

const agentLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
agentLines.on("line", (line) => {
  const msg = tryParse(line);
  if (msg) {
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      interceptPermission(msg);
    } else if (msg.method === "$/cancel_request") {
      // Agent retracted its own request (turn cancelled, or a settings hook won
      // inside the agent) — release sinain's card too.
      const entry = pendingPermissions.get(msg.params?.requestId);
      if (entry && !entry.settled) {
        entry.settled = true;
        entry.abort.abort();
        pendingPermissions.delete(msg.params?.requestId);
      }
    } else if (isResponse(msg) && newSessionRequests.has(msg.id)) {
      const cwd = newSessionRequests.get(msg.id);
      newSessionRequests.delete(msg.id);
      const sessionId = msg.result?.sessionId;
      if (sessionId && cwd) sessionCwds.set(sessionId, cwd);
    }
  }
  process.stdout.write(`${line}\n`);
});

const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
clientLines.on("line", (line) => {
  const msg = tryParse(line);
  if (msg) {
    if ((msg.method === "session/new" || msg.method === "session/load") && msg.id !== undefined) {
      if (typeof msg.params?.cwd === "string") newSessionRequests.set(msg.id, msg.params.cwd);
    } else if (isResponse(msg) && pendingPermissions.has(msg.id)) {
      const entry = pendingPermissions.get(msg.id);
      pendingPermissions.delete(msg.id);
      if (entry.settled) return; // sinain already answered; swallow the stale editor reply
      entry.settled = true;
      entry.abort.abort(); // closes /agent/approve — sinain-core dismisses the card
    }
  }
  child.stdin.write(`${line}\n`);
});
