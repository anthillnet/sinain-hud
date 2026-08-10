/** Smoke client — mirrors sinain-chat-agent/smoke_client.py.
 *
 *   npm run smoke -- "what do you know about my recent work?"
 *   npm run smoke -- --status            (health probe only)
 *   npm run smoke -- --cancel-after 2 "long question"   (test mid-turn cancel)
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const cancelIdx = args.indexOf("--cancel-after");
const cancelAfterS = cancelIdx >= 0 ? Number(args[cancelIdx + 1]) : 0;
const message = args
  .filter((a, i) => !a.startsWith("--") && (cancelIdx < 0 || i !== cancelIdx + 1))
  .join(" ") || "reply with exactly: pong";
const port = process.env.SINAIN_CHAT_WS_PORT || "9610";

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const t0 = Date.now();
let firstToken = 0;

ws.on("open", () => {
  if (statusOnly) {
    ws.send(JSON.stringify({ type: "status" }));
    return;
  }
  ws.send(JSON.stringify({ message, context: { kind: "main" } }));
  if (cancelAfterS > 0) {
    setTimeout(() => {
      console.log(`\n[smoke] sending cancel after ${cancelAfterS}s`);
      ws.send(JSON.stringify({ cancel: true }));
    }, cancelAfterS * 1000);
  }
});

ws.on("message", (raw) => {
  const ev = JSON.parse(String(raw)) as Record<string, unknown>;
  switch (ev.type) {
    case "status":
      console.log(`[smoke] status: ${JSON.stringify(ev)}`);
      ws.close();
      break;
    case "token":
      if (!firstToken) {
        firstToken = Date.now();
        console.log(`[smoke] first token @ ${((firstToken - t0) / 1000).toFixed(2)}s`);
      }
      process.stdout.write(String(ev.text ?? ""));
      break;
    case "tool_call":
      console.log(`\n[smoke] tool_call ${ev.tool_name} ${JSON.stringify(ev.tool_args)}`);
      break;
    case "tool_result":
      console.log(`[smoke] tool_result ${ev.tool_name}: ${String(ev.tool_result).slice(0, 120)}…`);
      break;
    case "usage_tick":
      console.log(`\n[smoke] usage_tick ${JSON.stringify(ev.usage)}`);
      break;
    case "done":
      console.log(`\n[smoke] done @ ${((Date.now() - t0) / 1000).toFixed(2)}s usage=${JSON.stringify(ev.usage)}`);
      ws.close();
      break;
    case "error":
      console.error(`\n[smoke] ERROR: ${ev.text} usage=${JSON.stringify(ev.usage)}`);
      ws.close();
      break;
  }
});

ws.on("error", (e) => {
  console.error(`[smoke] ws error: ${e.message}`);
  process.exit(1);
});
ws.on("close", () => process.exit(0));
