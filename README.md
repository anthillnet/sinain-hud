# Sinain <img src="media/screen-recording-2026-03-26.gif" alt="Sinain HUD" width="120" align="right">

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/anthillnet/sinain-hud/actions/workflows/ci.yml/badge.svg)](https://github.com/anthillnet/sinain-hud/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@geravant/sinain)](https://www.npmjs.com/package/@geravant/sinain)
[![macOS 12.3+](https://img.shields.io/badge/macOS-12.3%2B-black?logo=apple)](https://support.apple.com/macos)
[![LongMemEval IPR 82.8%](https://img.shields.io/badge/LongMemEval%20IPR-82.8%25-success)](docs/LONGMEMEVAL-AUDIT.md)

**Context OS** — ambient intelligence for builders. Captures what you see and hear, distills it into a private knowledge graph, accessible from MCP, a web UI, and a screen-recording-invisible HUD overlay.

<p align="center">
  <img src="docs/media/sinain-demo-full.gif" alt="Sinain demo" width="720">
</p>

**[Quick Start](#quick-start)** · **[Docs](docs/)** · **[Privacy](docs/privacy-protection-design.md)** · **[Configuration](docs/CONFIGURATION.md)** · **[Contributing](CONTRIBUTING.md)**

---

### You, Augmented

Sinain captures your screen and audio continuously, distills the stream into a **structured live knowledge graph** of facts, entities, and decisions, and exposes that graph through every interface: MCP, a web UI, and an invisible HUD overlay.

- **Capture** — screen frames + system audio, with `<private>` tag stripping and auto-redaction of credentials and tokens *before* anything leaves your machine.
- **Distill** — facts (atomic claims), entities (people / projects / topics), decisions (what was chosen and why) — extracted by an LLM, integrated by deterministic graph operations (no LLM in the integration step).
- **Access from anywhere** — **MCP server** for agents (Claude Code, Codex, Goose, OpenClaude, Junie), **web UI** at `localhost:9500/knowledge/ui/` for browsing, and a **HUD overlay** for in-the-moment recall.

The HUD overlay is invisible to screen capture — never appears in screenshots, recordings, or screen shares.
