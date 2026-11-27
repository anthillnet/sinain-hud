# chat-harness-bench

Multi-candidate bake-off to pick the harness for sinain's responsive **chat mode**
(resident Python sidecar). See `docs/chat-harness-evaluation.md` for the why.

Every candidate implements ONE adapter contract (`contract.py`) — which is also the
WebSocket event vocabulary the overlay needs — so the winning adapter is the
production integration, and swapping harnesses is a one-file change.

## Layout
- `contract.py`   — `Adapter` ABC + `Event` stream (token / tool_call / tool_result / progress / done).
- `sinain_tools.py` — shared tool surface (sinain memory/context-vision/notify/health via
  sinain-core HTTP + bash/read_file). Each candidate is wired to THESE, so we test
  whether it actually operates sinain's tools.
- `fixtures.py`   — identical prompts; `expected_tools` scores tool-use quality.
- `adapters/`     — one module per candidate. `baseline` (raw OpenAI loop) is the latency floor.
- `runner.py`     — runs fixtures × adapters, prints metrics, writes `results/`.

## Setup
```bash
cd chat-harness-bench
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # baseline only; candidates bring own deps
# .env (gitignored) already holds OPENROUTER_API_KEY + BENCH_MODEL=deepseek/deepseek-v4-flash
```
For live sinain tools, run sinain-core first (`cd sinain-core && npm run dev`) so the
`sinain_*` tools hit a real `/knowledge`, `/agent/*`, `/health`. Without it they
return a clear `[MOCK: ...]` marker and the loop still runs.

## Run
```bash
python runner.py                         # baseline, all fixtures
python runner.py --adapter baseline --fixture memory
python runner.py --adapter all           # every implemented adapter (stubs fail loudly)
```

## Metrics
- `ttfc_ms` — time to first **content** token (reasoning deltas excluded; deepseek-v4-flash
  reasons first, so this is the responsiveness number that matters).
- `final_ms` — time to completion.
- `tool_quality` — did it invoke an expected tool? (pass / FAIL / n/a)
- `setup_ms` — boot-once warm-up (the resident sidecar pays this once, not per turn).

## Status
- ✅ `baseline` — implemented (reference / latency floor).
- ⛔ `openhands`, `hermes`, `smolagents`, `gptme` — stubs; install + implement per file header.
- TS controls (Open Harness, Cline SDK) — separate node runner, TODO.

⚠️ `.env` holds a real OpenRouter key pasted during setup — gitignored; **rotate after the spike.**
