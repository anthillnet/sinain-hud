# Cerebras backend test stand

Connect SinainHUD to [Cerebras Inference](https://inference-docs.cerebras.ai/quickstart)
as a cloud analysis backend. Cerebras serves its own open models on very fast
hardware via an **OpenAI-compatible** API (Bearer auth, `POST /v1/chat/completions`),
which is exactly the shape `sinain-core`'s analyzer already speaks — so wiring it
in is config-only.

## 1. Smoke test (no sinain-core needed)

Proves your key works and that a Cerebras model produces sinain's `{hud, digest}`
JSON contract. Zero dependencies — just Node 18+.

```bash
export CEREBRAS_API_KEY=csk-...            # from https://cloud.cerebras.ai
node tools/cerebras-test-stand/check.mjs   # uses gpt-oss-120b by default
node tools/cerebras-test-stand/check.mjs qwen-3-32b   # or any listed model id
```

It (1) lists the models your key can see, (2) runs an analyzer-shaped chat
completion, (3) reports latency / tokens-per-sec, (4) validates the response
parses into `{hud, digest}`, and (5) exercises the **SLM-ROI lane** — the exact
`response_format: json_object` region-picking request the fast "auto-detect
issues" eyes send. Exit 0 = both lanes good to go.

## 2. Run the full system in cloud mode against Cerebras

```bash
cp tools/cerebras-test-stand/.env.cerebras.example .env.cerebras
# edit CEREBRAS_API_KEY
set -a && . ./.env.cerebras && set +a
cd sinain-core && npm run dev
```

Or inline, just the analyzer:

```bash
ANALYSIS_PROVIDER=cerebras CEREBRAS_API_KEY=csk-... npm --prefix sinain-core run dev
```

## How it's wired

`ANALYSIS_PROVIDER=cerebras` (added in `config.ts` / `types.ts`) reuses the
existing `callOpenRouter` path in `agent/analyzer.ts` and only changes the
defaults:

| Setting | Cerebras default | Why |
|---|---|---|
| endpoint | `https://api.cerebras.ai/v1/chat/completions` | OpenAI-compatible |
| api key | `CEREBRAS_API_KEY` (or `ANALYSIS_API_KEY`) | Bearer auth |
| model | `gpt-oss-120b` | a current Cerebras production model |
| fallback models | _(empty)_ | the google/anthropic defaults would 404 on Cerebras |
| agent vision | off | Cerebras models are text-only |
| ROI cloud model | `gpt-oss-120b` | the SLM-ROI lane follows the analyzer onto Cerebras |
| ROI max tokens | `512` | 256 truncates a large model's pretty-printed region JSON |

### The two lanes, in parallel

`ANALYSIS_PROVIDER=cerebras` wires **both** analysis lanes to Cerebras:

- **Analyzer** (`agent/analyzer.ts`) — the hud/digest call.
- **SLM-ROI** (`agent/region-detector.ts`) — the fast, screen-change-driven
  "auto-detect issues" eyes. It prefers a local Ollama SLM, but with no Ollama
  present it auto-flips to its cloud lane, which now defaults to Cerebras (same
  endpoint/key/model family as the analyzer) instead of OpenRouter+`google/*`.
  Cerebras' high token/s suits this low-latency lane well.

One gotcha we hit and fixed: a 120B model pretty-prints JSON and would
intermittently truncate at the old 256-token region cap (`finish_reason=length`
→ unparseable → no eyes that tick). The Cerebras default is now 512.

## Known limitations

- **No vision.** Cerebras models are text-only, so agent vision auto-disables.
  Screen understanding still works via `sense_client` OCR; for cloud vision you'd
  keep an OpenRouter/Gemini vision model.
- **No `usage.cost`.** Cerebras returns token counts but no cost, so `CostTracker`
  reports `$0` for these ticks (token totals are still tracked).
- **No audio (transcription can't run on Cerebras).** Cerebras serves text +
  vision models only — no speech-to-text. Cloud transcription is now
  provider-agnostic (`TRANSCRIPTION_ENDPOINT` / `TRANSCRIPTION_API_KEY` /
  `TRANSCRIPTION_MODEL`, default OpenRouter), but you can't point it at Cerebras.
  For a Cerebras stand, transcribe **locally** (`TRANSCRIPTION_BACKEND=local`,
  on-device whisper) or keep an audio-capable cloud endpoint (OpenRouter/Gemini)
  just for audio — the analyzer key and the transcription key are independent.
