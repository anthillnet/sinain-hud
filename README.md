# Sinain <img src="media/screen-recording-2026-03-26.gif" alt="Sinain HUD" width="120" align="right">

[![FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](LICENSE)
[![CI](https://github.com/anthillnet/sinain-hud/actions/workflows/ci.yml/badge.svg)](https://github.com/anthillnet/sinain-hud/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@geravant/sinain)](https://www.npmjs.com/package/@geravant/sinain)
[![macOS 12.3+](https://img.shields.io/badge/macOS-12.3%2B-black?logo=apple)](https://support.apple.com/macos)
[![LongMemEval IPR 82.8%](https://img.shields.io/badge/LongMemEval%20IPR-82.8%25-success)](docs/LONGMEMEVAL-AUDIT.md)

**Context OS** — ambient intelligence for builders. Captures what you see and hear, distills it into a private knowledge graph, accessible from MCP, a web UI, and a screen-recording-invisible HUD overlay.

<p align="center">
  <img src="docs/media/sinain-flow.gif" alt="Sinain flow — highlight a region, open chat or a CLI agent with full context, hand off to any assistant" width="720">
</p>

**[Quick Start](#quick-start)** · **[Docs](docs/)** · **[Privacy](docs/privacy-protection-design.md)** · **[Configuration](docs/CONFIGURATION.md)** · **[Contributing](CONTRIBUTING.md)**

---

### From a glance to a working agent

Stop copy-pasting context into your AI. Sinain watches your screen and **highlights the regions where an agent could help** — then opens that region as a chat or a CLI agent already holding your full context (see the demo above).

1. **Spot a region** — Sinain highlights actionable areas on the screen as you work.
2. **Engage** — click a highlighted region and choose how to act on it: a **chat** or a **CLI agent**.
3. **Chat, in context** — the chat opens already holding the region, your live situational context, and relevant facts from the knowledge graph.
4. **Hand off to a CLI agent** — escalate the same thread into a coding agent (Claude Code, Codex, Goose, Junie…), preseeded with identical knowledge.
5. **Your tools, your setup** — pick which assistant backs the chat and the handoff; carry the full transcript, or copy a portable context seed for any other tool.
6. **Or aim it yourself** — double-tap the eye to draw a region manually and ask about exactly what you want.

No dump, no re-paste — the context travels with the task. Every assistant in the loop is yours to choose, configured in [`agents.json`](docs/AGENT-ROSTER.md).

### You, Augmented

Sinain captures your screen and audio continuously, distills the stream into a **structured live knowledge graph** of facts, entities, and decisions, and exposes that graph through every interface where you might need it.

- **Capture** — screen frames + system audio, with `<private>` tag stripping and auto-redaction of credentials and tokens *before* anything leaves your machine.
- **Distill** — facts (atomic claims), entities (people / projects / topics), decisions (what was chosen and why) — extracted by an LLM, integrated by deterministic graph operations (no LLM in the integration step → **[82.8% Information Preservation Rate](docs/LONGMEMEVAL-AUDIT.md)** on the [LongMemEval benchmark](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025, 500 questions), measured against full-context oracle).
- **Access from anywhere** — **MCP server** for agents (Claude Code, Codex, Goose, OpenClaude, Junie), **web UI** at `localhost:9500/knowledge/ui/` for browsing, and a **HUD overlay** for in-the-moment recall.

The HUD overlay is invisible to screen capture — never appears in screenshots, recordings, or screen shares.

### Agent-Agnostic

Sinain feeds the same screen and audio context to any MCP-compatible agent. Switch agents on the fly — no restart, no context loss.

- Tested with Claude Code, OpenClaude, Codex, Goose, Junie, and [Hermes](https://github.com/NousResearch/Hermes-Agent) (NousResearch). Most agents connect over MCP; pipe-mode agents like aider and Hermes work without it too.
- Pick agents in the overlay's flash-icon selector — spawn tasks can route to any profile in your roster.
- Add custom profiles (personal Claude config, alternate models) by editing [`agents.json`](docs/AGENT-ROSTER.md). The roster is the source of truth.
- Knowledge modules travel with you — export from one machine, import on another.

### Privacy Controls

By default, sinain uses cloud APIs (OpenRouter) for transcription and analysis. When you need tighter control, switch privacy modes — no code changes, one env var.

- `off` → `standard` → `strict` → `paranoid` — four modes in `~/.sinain/.env`.
- `paranoid` mode: Ollama + whisper.cpp. **Zero network calls at runtime** — the embedding model is pre-cached during the setup wizard (`sinain setup-embedding`), so subsequent runs are fully offline.
- HUD overlay is invisible to screen capture (`NSWindow.sharingType = .none` — see `overlay/macos/Runner/AppDelegate.swift:70`). Verifiable via split-screen recording with QuickTime + OBS + Loom — the HUD is absent from all three.

## Quick Start

```bash
npx @geravant/sinain@latest start
```

That's it. On first run, sinain will:
1. Run an **interactive setup wizard** — transcription backend, API key, agent, privacy mode
2. **Auto-download** the overlay app (~17MB), sck-capture binary (~5MB), embedding model (~90MB), and Python dependencies
3. **Start all services** — sinain-core, sense_client, overlay, and agent

All assets are cached locally after the first install. In `paranoid` mode, subsequent runs are fully offline — no network calls at runtime.

> **Pin `@latest`** on every invocation. `npx @geravant/sinain` (without `@latest`) caches *forever* against the unversioned spec — you'd silently keep running an old version for months. Sinain self-updates automatically when stale, but pinning `@latest` makes it explicit and saves a redundant relaunch.

> **Re-run the wizard** anytime: `npx @geravant/sinain@latest start --setup`

### Prerequisites

- **macOS 12.3+** — Sinain uses ScreenCaptureKit (introduced in 12.3). Earlier versions are not supported in this release. Apple Silicon and Intel both work.
- **Node.js 18+** — [nodejs.org](https://nodejs.org/) (LTS recommended)
- **Python 3.10+** — `brew install python3` (macOS) or [python.org](https://www.python.org/downloads/)
- **OpenRouter API key** (optional for local-only mode) — [openrouter.ai](https://openrouter.ai)
- **Network access during first install** — the wizard downloads ~112MB total (overlay app, sck-capture binary, sentence-transformer embedding model). All cached locally; subsequent runs need network only for cloud LLM API calls (or zero network in `paranoid` mode).

> **Fully local?** No API key needed. Ollama + whisper-cli = zero cloud at runtime. See [Running Fully Local](#running-fully-local).

> **First install reproducibility?** See [docs/cold-install-verification.md](docs/cold-install-verification.md) for a step-by-step verified-on-fresh-user-account guide, including the timing measurement and the failure modes the audit caught + fixed.

### macOS Permissions

1. **System Settings → Privacy & Security → Screen Recording** — add your Terminal, then **quit and reopen Terminal** (macOS TCC entitlements only apply to processes started after the grant)
2. **System Settings → Privacy & Security → Microphone** — same: add Terminal, then restart Terminal

> Sinain detects when these permissions are missing and surfaces a clear restart-instruction banner; you'll never get a silent degraded mode.

### Managing sinain

```bash
npx @geravant/sinain@latest stop             # stop all services
npx @geravant/sinain@latest status           # check what's running
npx @geravant/sinain@latest start --setup    # re-run setup wizard
npx @geravant/sinain@latest start --no-sense # skip screen capture
npx @geravant/sinain@latest start --no-overlay  # headless mode
```

> Always pin `@latest` — see the note in [Quick Start](#quick-start) above.

## Architecture

```
┌─── Your Device ─────────────────────────────────────────────────────┐
│                                                                     │
│  sck-capture (Swift)                                                │
│    ├─ system audio (PCM) ──► sinain-core :9500                      │
│    └─ screen frames (JPEG) ──► sense_client ─── POST /sense ──►    │
│                                                      │              │
│                              ┌────────────────────────┘              │
│                              │                                      │
│                         sinain-core                                 │
│                           ├─ audio pipeline → transcription         │
│                           ├─ agent loop → digest + HUD text         │
│                           ├─ knowledge graph (private, on-device)   │
│                           └─ WebSocket feed                         │
│                                  │                                  │
│                                  ▼                                  │
│                           overlay (Flutter)                         │
│                           private, invisible to screen capture      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Language | What it does | Docs |
|---|---|---|---|
| **sinain-core** | TypeScript | Central hub: audio pipeline, agent loop, knowledge graph, WS feed | [README](sinain-core/README.md) |
| **overlay** | Dart / Swift | Private HUD (macOS), display modes, hotkeys | [Hotkeys](docs/HOTKEYS.md) |
| **sense_client** | Python | Screen capture, SSIM diff, OCR, privacy filter | [sense_client/](sense_client/) |
| **sck-capture** | Swift | ScreenCaptureKit: system audio + screen frames | [tools/sck-capture/](tools/sck-capture/) |
| **sinain-agent-runner** | Bash | Shell harness that connects any agent to sinain-core | [sinain-agent-runner/](sinain-agent-runner/) |
| **sinain-knowledge** | TypeScript | Curation, playbook, eval, portable knowledge modules | [Knowledge System](docs/knowledge-system.md) |
| **sinain-mcp-server** | TypeScript | MCP server exposing sinain tools to agents | [sinain-mcp-server/](sinain-mcp-server/) |

## Configuration

Sinain splits config across two files in `~/.sinain/`:

- **`.env`** — secrets (API keys) and infrastructure (ports, audio device, privacy mode, analyzer LLM).
- **`agents.json`** — agent roster (default agent, allowed-tools whitelists, analyzer pacing).

Both are created by the setup wizard. To re-run: `npx @geravant/sinain start --setup`.

### Agents & profiles → `agents.json`

The agent roster lives in `~/.sinain/agents.json`. Each entry is a profile mapping a name to a binary + behavior type + optional env, settings, and model overrides. The overlay's flash-icon selector lets you pick which profile handles spawn tasks at runtime. Custom profiles like `pclaude` (personal claude with its own config dir) are first-class — the dispatch decision keys off `profile.type`, not the profile name.

See **[Agent Roster & Profiles](docs/AGENT-ROSTER.md)** for the complete schema, recipes, and routing model.

### Context Analysis (HUD summarizer) → `.env`

The context analysis loop runs every 3–30 seconds, sending recent audio/screen context to an LLM. It produces the short HUD text shown on the overlay plus a richer digest stored in the feed buffer for the knowledge graph.

| Variable | Default | Description |
|---|---|---|
| `ANALYSIS_PROVIDER` | `openrouter` | `openrouter` (cloud) or `ollama` (local, free) |
| `ANALYSIS_MODEL` | `google/gemini-2.5-flash-lite` | Primary model for text analysis |
| `ANALYSIS_VISION_MODEL` | `google/gemini-2.5-flash` | Auto-selected when screen images are present |
| `ANALYSIS_ENDPOINT` | *(auto per provider)* | Override for custom OpenAI-compatible endpoints |
| `ANALYSIS_API_KEY` | *(from OPENROUTER_API_KEY)* | API key; not needed for ollama |
| `ANALYSIS_FALLBACK_MODELS` | `gemini-2.5-flash,...` | Comma-separated fallback chain |

### Other Key Settings → `.env`

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required (unless `ANALYSIS_PROVIDER=ollama` + local transcription) |
| `PRIVACY_MODE` | `off` | `off` / `standard` / `strict` / `paranoid` |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference.

## Privacy Modes

| Mode | What it does |
|---|---|
| `off` | All data flows freely — maximum insight quality |
| `standard` | Auto-redacts credentials before cloud APIs (wizard default) |
| `strict` | Only summaries leave your machine — no raw text sent to cloud |
| `paranoid` | Fully local: Ollama + whisper.cpp. Zero network calls at runtime (embedding model pre-cached at install). |

See [Privacy Threat Model](docs/privacy-protection-design.md) for the full design.

## Hotkeys

SinainHUD is mouse-driven — there's a single global hotkey:

| Shortcut | Action |
|---|---|
| `Cmd+Shift+P` | Reset window position (recover an off-screen overlay) |

Everything else (cycle view, switch tabs, capture toggles, quit) is a click in the overlay. See [docs/HOTKEYS.md](docs/HOTKEYS.md).

## Running Fully Local

No API keys, no cloud calls, no data leaves your laptop.

```bash
# 1. Install prerequisites
brew install ollama whisper-cpp
ollama serve &

# 2. Pull the recommended models (~12 GB total)
ollama pull phi4-mini qwen2.5vl:7b

# 3. Start in paranoid mode
./start.sh --paranoid
```

Or via the setup wizard: `npx @geravant/sinain@latest start --setup` → select **Local / Paranoid**.

### What Runs Where

| Component | Model | Task | VRAM |
|-----------|-------|------|------|
| Screen OCR | qwen2.5vl:7b | Read screen content via Ollama | 4.7 GB |
| Analysis + Distillation | phi4-mini | Context analysis, build knowledge graph | 2.5 GB |
| Audio transcription | whisper.cpp (large-v3-turbo) | Speech-to-text | 1.5 GB |
| Embeddings | all-MiniLM-L6-v2 | Semantic search (ONNX, in-process) | ~0.1 GB |

**Minimum:** 16 GB RAM (Apple Silicon M1+) &nbsp; **Recommended:** 24 GB RAM

### Choosing Models

The defaults (qwen2.5vl + phi4-mini) are [benchmarked](docs/local-mode.md#benchmarked-models) for the best quality/speed tradeoff. Swap them with env vars:

```bash
SINAIN_LOCAL_VISION=gemma4:e2b SINAIN_LOCAL_LLM=gemma4:e2b ./start.sh --paranoid
```

See **[docs/local-mode.md](docs/local-mode.md)** for benchmarks, hardware tiers, model recommendations, and advanced configuration.

## Setup Guides

| Setup | Guide |
|---|---|
| **Agent Roster & Profiles** | [docs/AGENT-ROSTER.md](docs/AGENT-ROSTER.md) — pick agents, add custom profiles |
| **Bare Agent** | [docs/INSTALL-BARE-AGENT.md](docs/INSTALL-BARE-AGENT.md) — the default install path |
| From Source | `git clone`, `cp .env.example ~/.sinain/.env`, `./start.sh` |

## Knowledge System

Sinain builds a persistent knowledge graph from everything it captures — audio transcriptions, screen OCR, and agent interactions. Facts are distilled incrementally (on buffer full and session end), stored in an EAV triplestore with graph relationships, and retrieved via hybrid search (FTS5 + tag-based + entity graph backrefs with RRF fusion).

The integration step is fully deterministic — no LLM decides what to store. Every extracted fact is preserved.

```bash
npx @geravant/sinain export-knowledge   # export playbook, modules, graph
npx @geravant/sinain import-knowledge ~/sinain-knowledge-export.tar.gz
```

See [Knowledge System docs](docs/knowledge-system.md) for architecture details.

### Querying knowledge from any MCP agent

Sinain's knowledge graph is exposed to any MCP-aware agent via the bundled MCP server. See **[Connect Your Coding Agent (MCP)](#connect-your-coding-agent-mcp)** below for setup.

## Connect Your Coding Agent (MCP)

Sinain ships an MCP server that exposes 7 concise `sinain_*` tools — `sinain_context` (current situation), `sinain_memory_query` / `sinain_memory_store` (knowledge graph read/write), `sinain_notify` (HUD feed), `sinain_health`, and the `sinain_get_escalation` / `sinain_respond` escalation pair — to any MCP-aware agent. Register it once and the agent can use your knowledge graph as persistent memory and surface text on the HUD from any project.

```bash
npx @geravant/sinain@latest mcp install
```

The wizard detects which MCP agents you have installed and registers sinain for the ones you select. Re-runnable any time; idempotent.

| Agent | Setup | Config it touches |
|---|---|---|
| **Claude Code** | `mcp install` (auto via wizard) | `~/.claude.json` (`claude mcp add`) |
| **Claude Desktop** | `mcp install` (auto via wizard) | `~/Library/Application Support/Claude/claude_desktop_config.json` (mac) |
| **Cursor** | `mcp install` (auto via wizard) | `~/.cursor/mcp.json` |
| **Codex** | `mcp install` (auto via wizard) | `~/.codex/config.toml` (`codex mcp add`) |
| **Goose** | `mcp install` (auto via wizard) | `~/.config/goose/config.yaml` |
| **Junie** | `mcp install` (auto via wizard) | `~/.junie/mcp/mcp.json` |

> **Already in `sinain onboard`** — step 6 of the advanced flow runs the same registration. Quickstart asks once if any MCP agent is detected.

- See [docs/MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) for setup details, troubleshooting, and the manual `pclaude` / alternate `CLAUDE_CONFIG_DIR` recipe.
- See [docs/MCP-CAPABILITIES.md](docs/MCP-CAPABILITIES.md) for what each tool enables, with example prompts and end-to-end recipes.

## Deep Dives

| Topic | Doc |
|---|---|
| Knowledge System | [docs/knowledge-system.md](docs/knowledge-system.md) |
| Knowledge API (HTTP) | [docs/KNOWLEDGE-API.md](docs/KNOWLEDGE-API.md) |
| MCP Integration (setup) | [docs/MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) |
| MCP Capabilities (tools + recipes) | [docs/MCP-CAPABILITIES.md](docs/MCP-CAPABILITIES.md) |
| LongMemEval Audit | [docs/LONGMEMEVAL-AUDIT.md](docs/LONGMEMEVAL-AUDIT.md) |
| Privacy Threat Model | [docs/privacy-protection-design.md](docs/privacy-protection-design.md) |
| Full Configuration | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| All Hotkeys | [docs/HOTKEYS.md](docs/HOTKEYS.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Split licensing — open code, protected product:

- **Core (this repo): [FSL-1.1-ALv2](LICENSE)** (Functional Source License).
  Free for any use except offering a competing product or service; each
  release automatically becomes Apache-2.0 two years after publication.
- **MCP server (`sinain-mcp-server/`) + the knowledge export/import format:
  [MIT](sinain-mcp-server/LICENSE)** — integrate sinain as a memory layer or
  build on the protocol without restrictions.
- Versions published before the switch (≤ 0.3.x MIT era) remain MIT.
