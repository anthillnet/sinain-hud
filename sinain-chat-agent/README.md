# sinain-chat-agent (prototype)

Resident **OpenHands** chat sidecar behind a WebSocket — the responsive chat-mode harness
for sinain (MAIN thread + ROI). Picked via the bake-off in
`docs/chat-harness-evaluation.md`. Stack: **qwen3.5-flash, reasoning OFF** (fast,
non-reasoning) + **resident** Conversation (warm) + **lean 7-tool** surface + token streaming.
Measured: ~0.6s first token, 1–4s end-to-end with real sinain tool calls (~10× a reasoning model).

## Run
```bash
cd sinain-chat-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set OPENROUTER_API_KEY
# sinain-core should be running on :9500 so sinain_* tools return real data
python sidecar.py                      # warms, then serves ws://127.0.0.1:9610
# in another shell:
python smoke_client.py "what do you know about my recent work?"
```

## Protocol (sinain-core ChatService ↔ sidecar, WebSocket)
- → `{"message": "...", "context": {"kind":"main"|"roi","seed":"..."}}` · `{"cancel": true}`
- ← event frames: `token` (content delta) / `tool_call` / `tool_result` / `progress` / `done` / `error`

This is the contract sinain-core relays to the overlay's existing WS. Swapping harness later
= reimplement `ChatAgent` against the same protocol.

## Tools (lean 7 — see tools.py)
`sinain_memory_query`, `sinain_context` (screen OCR/vision + audio + apps), `sinain_memory_store`,
`read_file`, `bash` (read-only-sandboxed), `grep`, `glob`. Tool output capped at 4 KB so a huge
payload (e.g. `sinain_context`) can't blow up latency. Connectors (GSuite/Slack/Glean) come later
via deferred MCP loading, not eager load.

## Config (env / .env)
`OPENROUTER_API_KEY` · `SINAIN_CHAT_MODEL` (default `qwen/qwen3.5-flash-02-23`) ·
`SINAIN_CHAT_REASONING` (`off` fast / `on` slower) · `SINAIN_CORE_URL` · `SINAIN_CHAT_WS_PORT` (9610).

`SINAIN_CHAT_VENV` / `SINAIN_CHAT_WORKSPACE` relocate the self-bootstrapped venv and scratch
workspace (packaged installs point them at `~/.sinain/chat-venv` / `~/.sinain/chat-workspace`
because the signed .app bundle must not be written to).

## Status
Prototype (Phase 0→1). Next: sinain-core `ChatService` WS client + overlay wiring; lifecycle
supervision in `launch-backend.sh`; DMG bundling. Terminal mode keeps the roster agent unchanged.
