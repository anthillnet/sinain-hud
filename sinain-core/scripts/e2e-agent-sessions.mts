// Temporary e2e smoke test for the agent-session spine. Run: npx tsx e2e-agent-sessions.mts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createAppServer } from "../src/server.js";
import { FeedBuffer } from "../src/buffers/feed-buffer.js";
import { SenseBuffer } from "../src/buffers/sense-buffer.js";
import { WsHandler } from "../src/overlay/ws-handler.js";
import { AgentSessionRegistry } from "../src/agent-sessions/registry.js";
import { ApprovalManager } from "../src/agent-sessions/approvals.js";
import { setupCommands } from "../src/overlay/commands.js";

const PORT = 9573;
const BRIDGE = new URL("../../tools/sinain-bridge/sinain-bridge.mjs", import.meta.url).pathname;
const pExecFile = promisify(execFile);

const results: [string, boolean, string?][] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

function pExecFileWithStdin(frame: object): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("node", [BRIDGE, "--source", "codex"], {
      env: { ...process.env, SINAIN_PORT: String(PORT) },
      timeout: 150_000,
    }, (_err, stdout) => resolve({ stdout: (stdout ?? "").toString().trim() }));
    child.stdin!.end(JSON.stringify(frame));
  });
}

async function main() {
  const feedBuffer = new FeedBuffer();
  const senseBuffer = new (SenseBuffer as any)();
  const wsHandler = new WsHandler();
  const registry = new AgentSessionRegistry();
  const approvals = new ApprovalManager((request) => {
    registry.finishApproval(request.sessionId, "ask", request.command);
  });
  wsHandler.setAgentApprovalSupplier(() => approvals.pending());
  let flush = false;
  registry.onChange(() => {
    if (flush) return;
    flush = true;
    queueMicrotask(() => {
      flush = false;
      wsHandler.broadcastAgentSessions({ type: "agent_sessions", sessions: registry.snapshot(), ...registry.counts() });
    });
  });

  const config: any = { port: PORT, host: "127.0.0.1", agentApproveTimeoutMs: 4000, agentEnrichEnabled: true };
  const deps: any = {
    config, feedBuffer, senseBuffer, wsHandler,
    agentSessions: { registry, approvals },
    onSenseEvent: () => {}, onFeedPost: () => {}, getAgentDigest: () => "",
  };
  setupCommands({
    wsHandler, config,
    onUserMessage: async () => {}, onUserCommand: () => {}, onCommand: () => {},
    onAgentApprovalReply: (id: string, behavior: "allow" | "deny" | "always", answer?: string) => {
      const request = approvals.get(id);
      if (!request || !approvals.resolve(id, behavior, answer)) return;
      registry.finishApproval(request.sessionId, behavior, request.command);
      wsHandler.broadcastRaw({ type: "agent_approval_resolved", id, behavior } as any);
    },
  } as any);

  const server = createAppServer(deps);
  await server.start();

  // Overlay stand-in
  const messages: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const waitFor = (pred: (m: any) => boolean, ms = 8000): Promise<any> =>
    new Promise((resolve, reject) => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
      const iv = setInterval(() => {
        const m = messages.find(pred);
        if (m) { clearTimeout(t); clearInterval(iv); resolve(m); }
      }, 25);
    });
  ws.on("message", (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise((r) => ws.on("open", r));

  // 1. SessionStart + PreToolUse via the real bridge (fire-and-forget)
  await pExecFileWithStdin({ session_id: "s1", hook_event_name: "SessionStart", cwd: process.cwd(), model: "gpt-5.2" });
  await pExecFileWithStdin({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  const snap1 = await waitFor((m) => m.type === "agent_sessions" && m.working === 1 && m.sessions?.[0]?.toolLine?.includes("npm test"));
  check("SessionStart+PreToolUse → agent_sessions broadcast", !!snap1, snap1.sessions[0].name);

  const recentFeedText = "feed context reaches agent enrichment";
  feedBuffer.push(recentFeedText, "normal", "audio");
  const enrich = await fetch(`http://127.0.0.1:${PORT}/agent/enrich?session_id=s1&cwd=${encodeURIComponent(process.cwd())}`).then((r) => r.json()) as any;
  check(
    "GET /agent/enrich never throws and skips unavailable LLM lane",
    enrich.ok === true
      && (enrich.brief.includes("Other agents") || enrich.brief.includes("[sinain] Ambient context"))
      && !enrich.brief.includes("Build-Context brief:"),
  );
  const audioCanonical = enrich.brief.includes("Recent activity (audio):");
  const audioVisible = enrich.brief.includes(recentFeedText);
  const audioSuppressed = enrich.brief.includes("(suppressed: privacy uninitialized)");
  check(
    "GET /agent/enrich uses canonical audio context",
    audioCanonical && (audioVisible || audioSuppressed),
    audioVisible ? "visible branch" : audioSuppressed ? "privacy-suppressed branch" : "missing canonical audio lines",
  );
  const refresh = await fetch(`http://127.0.0.1:${PORT}/agent/enrich?mode=refresh&session_id=s1&cwd=${encodeURIComponent(process.cwd())}`).then((r) => r.json()) as any;
  check(
    "GET /agent/enrich?mode=refresh returns situational sections only",
    refresh.ok === true
      && refresh.brief.length <= 700
      && !refresh.brief.includes("Other agents in flight:")
      && !refresh.brief.includes("Known about ")
      && !refresh.brief.includes("Build-Context brief:"),
    refresh.brief,
  );

  const { stdout: enrichOut } = await pExecFileWithStdin({ session_id: "s1", hook_event_name: "SessionStart", cwd: process.cwd() });
  if (enrich.brief) {
    let hookOutput: any;
    try { hookOutput = JSON.parse(enrichOut); } catch { /* checked below */ }
    check("bridge prints SessionStart additionalContext", hookOutput?.hookSpecificOutput?.hookEventName === "SessionStart" && !!hookOutput?.hookSpecificOutput?.additionalContext, enrichOut);
  } else {
    check("bridge keeps stdout empty for empty enrich brief", enrichOut === "", "empty-brief branch");
  }

  // 2. Blocking PermissionRequest → overlay approves → bridge unblocks with allow
  const approvedP = pExecFileWithStdin({ session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm publish --access public" } });
  const approvalMsg = await waitFor((m) => m.type === "agent_approval");
  check("PermissionRequest → agent_approval on WS", approvalMsg.request.command === "npm publish --access public", approvalMsg.request.title);
  const waitingSnap = await waitFor((m) => m.type === "agent_sessions" && m.waiting === 1);
  check("session marked waiting", waitingSnap.sessions[0].state === "waiting");
  ws.send(JSON.stringify({ type: "agent_approval_reply", id: approvalMsg.request.id, behavior: "allow" }));
  const { stdout: allowOut } = await approvedP;
  check("bridge prints allow decision", allowOut.includes('"behavior":"allow"') && allowOut.includes("hookSpecificOutput"), allowOut);
  const resolvedMsg = await waitFor((m) => m.type === "agent_approval_resolved" && m.id === approvalMsg.request.id);
  check("agent_approval_resolved broadcast", resolvedMsg.behavior === "allow");
  const backWorking = await waitFor((m) => m.type === "agent_sessions" && m.waiting === 0 && m.working === 1);
  check("session back to working", !!backWorking);

  // 3. Timeout path (4s config) → bridge gets ask sentinel
  const askP = pExecFileWithStdin({ session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /" } });
  const { stdout: askOut } = await askP;
  check("unanswered approval times out → ask sentinel", askOut === '{"decision":"ask"}', askOut);

  // 4. Deny path
  const denyP = pExecFileWithStdin({ session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push --force" } });
  const denyApproval = await waitFor((m) => m.type === "agent_approval" && m.request.command === "git push --force");
  const denyReason = "Protected branch; open a PR instead";
  ws.send(JSON.stringify({ type: "agent_approval_reply", id: denyApproval.request.id, behavior: "deny", answer: denyReason }));
  const { stdout: denyOut } = await denyP;
  check("deny decision and answer reach bridge", denyOut.includes('"behavior":"deny"') && denyOut.includes(`"reason":"${denyReason}"`), denyOut);

  // 5. Stop → done receipt; GET /agent/sessions
  await pExecFileWithStdin({ session_id: "s1", hook_event_name: "Stop", message: "published bridge v0.3" });
  const doneSnap = await waitFor((m) => m.type === "agent_sessions" && m.sessions?.[0]?.state === "done");
  check("Stop → done + summary", doneSnap.sessions[0].summary === "published bridge v0.3");
  const http = await fetch(`http://127.0.0.1:${PORT}/agent/sessions`).then((r) => r.json());
  check("GET /agent/sessions", http.sessions.length === 1 && http.working === 0);

  // 6. Late-joining client replays snapshot
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const replayed: any[] = [];
  ws2.on("message", (raw) => { try { replayed.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise((r) => ws2.on("open", r));
  await new Promise((r) => setTimeout(r, 300));
  check("late client gets agent_sessions replay", replayed.some((m) => m.type === "agent_sessions"));

  ws.close(); ws2.close();
  await server.destroy();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
