# sinain-chat-agent-js (prototype)

Resident sinain chat sidecar on the **Vercel AI SDK** — a drop-in replacement for
`sinain-chat-agent/` (OpenHands/Python) speaking the **same WS protocol** on :9610,
with no Python runtime: deps ship in `node_modules`, spawned from the bundled Node.

Why: the Python sidecar's operational tax (venv self-bootstrap, pip on user machines,
`SINAIN_CHAT_VENV` signed-bundle redirects, python provisioning) exists only to host
the OpenHands SDK, of which the chat lane uses a thin slice — an 8-tool streaming
loop. See the `fix(chat)` history for the tax receipts.

## Run

```bash
cd sinain-chat-agent-js
npm install
npm run dev                    # tsx, serves ws://127.0.0.1:9610
# production: npm run build && npm start
```

Opt-in via core's supervisor: `SINAIN_CHAT_IMPL=js` (default stays `python` until
the A/B settles). Core spawns `dist/sidecar.js` when built, else `src/sidecar.ts`
via sinain-core's tsx (dev checkout).

## Smoke tests

```bash
npm run smoke -- --status                      # health probe
npm run smoke -- "reply with exactly: pong"    # streaming turn
npm run smoke -- "use the bash tool to run 'uname -m' and tell me the output"
npm run smoke -- --cancel-after 2 "write a long essay"   # mid-turn cancel
```

## Protocol (identical to sidecar.py — sinain-core ChatService is the consumer)

- → `{"message": "...", "context": {"kind":"main"|"roi","seed":"...","source":"user"|"escalation"}}`
  · `{"cancel": true}` · `{"type":"status"}`
- ← `token` / `tool_call` / `tool_result` / `usage_tick` / `done` / `error` / `status`
- usage payloads are **deltas** since the last report (core's CostTracker sums blindly)

## Parity with sidecar.py

- 8-tool surface (`tools.ts` — port of `tools.py`, same endpoints, caps, bash sandbox)
- provider resolution from the active stack (cerebras / openrouter / local-ollama;
  `SINAIN_CHAT_*` overrides win; local mode never talks to a cloud endpoint —
  ollama is reached via its OpenAI-compatible `/v1` surface)
- env chain: process → own `.env` → `~/.sinain/.env` → repo `.env`; re-read every
  60s while degraded so adding a key heals without restart
- harness controls: idle watchdog (`SINAIN_CHAT_TURN_TIMEOUT`, 90s), per-turn caps
  (`SINAIN_CHAT_TURN_BUDGET_USD`, `SINAIN_CHAT_TURN_MAX_INPUT_TOKENS`), bounded
  resident history (`SINAIN_CHAT_CONTEXT_RESET_TOKENS`), mid-turn usage ticks
- serialization: one turn at a time; escalation turns drop when busy; a user turn
  preempts an in-flight escalation
- OpenRouter `usage.cost` captured by teeing the SSE response (litellm cost parity);
  reasoning-off injected the same way

## Known gaps vs Python

- an aborted step reports 0 tokens (`onStepFinish` never fires for it) — usage
  ticks cover long turns, but a cancelled first step is invisible to CostTracker
- DMG staging not wired yet (the flag defaults to python); staging needs
  `npm install --omit=dev` + `npm run build` of this dir, mirroring sinain-mcp-server
