# sinain-bridge

`sinain-bridge` forwards agent lifecycle hook events to the local sinain-core hub (the Agent Sessions surface in the overlay). Permission requests block and wait for a hub decision — an Allow / Always / Deny tap in the HUD; all other events are fire-and-forget and never interrupt the agent. One protocol, one bridge; every agent is a small adapter that points its hook/plugin config at the same frames.

```bash
node tools/sinain-bridge/install.mjs --list        # roster, detection, confidence
node tools/sinain-bridge/install.mjs --all         # install for every detected agent
node tools/sinain-bridge/install.mjs codex cursor  # or pick agents (runs even if undetected)
```

Add `--uninstall` to remove managed entries (originals restored byte-identical), `--dry-run` to preview. `install-claude.mjs` remains as a Claude-only shim.

## Capability matrix

| Agent | Config written | Capability | Confidence |
|---|---|---|---|
| claude (Claude Code) | `~/.claude/settings.json` hooks | monitor + **two-way approvals** | **verified** |
| codex | `~/.codex/hooks.json` + chained `notify` in `config.toml` | monitor + approvals (PermissionRequest hook); Stop via notify chain | **verified live** (codex 0.144: SessionStart/PreToolUse/PostToolUse/Stop confirmed end-to-end) |
| opencode | `~/.config/opencode/plugin/sinain-bridge.js` | monitor + **two-way approvals** (`/permission/{id}/reply`, allow→once, always→always, deny→reject) | doc-derived |
| cursor | `~/.cursor/hooks.json` (`beforeShellExecution` …, auto-ack so Cursor never blocks) | monitor | doc-derived |
| gemini | `~/.gemini/settings.json` hooks | monitor | doc-derived |
| qwen | `~/.qwen/settings.json` hooks | monitor | doc-derived |
| droid | `~/.factory/settings.json` hooks | monitor | doc-derived |
| qoder | `~/.qoder/settings.json` hooks | monitor | doc-derived |
| copilot | `~/.copilot/settings.json` hooks | monitor | doc-derived |
| kimi | `~/.kimi/config.toml` managed block | monitor | doc-derived |
| deepseek | `~/.deepseek/config.toml` managed block (`turn_end`) | monitor | doc-derived |
| kiro | `~/.kiro/agents/*.json` hooks merge | monitor | speculative |
| antigravity | `~/.antigravity` / `~/.gemini/antigravity` | monitor | speculative |
| codebuddy / workbuddy | `~/.codebuddy` / `~/.workbuddy` settings.json | monitor | speculative |
| mimocode | `~/.config/mimocode/plugin/` (opencode-style plugin) | monitor + approvals | speculative |
| amp | `~/.config/amp/plugins/` JS plugin | monitor | speculative |
| hermes | `~/.hermes/plugins/` YAML plugin | monitor | speculative |
| pi | `~/.pi/extensions/` JS extension | monitor | speculative |
| trae / zcode / grok / mistralvibe / kimicode / gajae | conventional dirs, Claude/Cursor-style hooks | monitor | speculative |

Confidence: **verified** = exercised against the real CLI; **doc-derived** = config path/shape from the Vibe Island v1.0.41 teardown; **speculative** = only the agent name is documented — the adapter uses the conventional config shape, is detection-gated (never installed by `--all` unless the agent's config dir exists), and may need adjusting against the real product.

## Safety guarantees (all adapters)

- One-time `.sinain-backup` of any file before first modification.
- Managed entries carry the `sinain-bridge` marker (or a managed-block/header comment) — install self-heals, uninstall removes only ours and restores originals byte-identical.
- Unparseable existing config → abort that adapter, write nothing.
- Codex `notify` is **chained**, not replaced: the original notifier keeps firing (saved in `~/.codex/sinain-notify-original.json`, restored on uninstall).

## Protocol

Lifecycle events POST to `/agent/event` (1.5 s cap, errors swallowed). `PermissionRequest` POSTs to `/agent/approve` and may wait up to 130 s; decisions come back as `{behavior: allow|deny|always|ask}` and are emitted in Claude Code's hook-output format — `{"decision":"ask"}` is the sentinel for "no answer, use your own prompt". Native event names (`beforeShellExecution`, `turn_end`, `pre_tool_call`, …) are normalized to the Claude vocabulary inside the bridge; the original is kept as `native_event_name`.

Env: `SINAIN_HOST` / `SINAIN_PORT` select the hub (default `127.0.0.1:9500`). Testing: `SINAIN_ADAPTER_HOME` fakes the home dir for all adapters; `CLAUDE_SETTINGS` and `CODEX_HOME` override per-agent paths.

## Tests

```bash
node tools/sinain-bridge/test-install.mjs          # framework + claude + codex
node tools/sinain-bridge/test-json-adapters.mjs    # JSON-hooks family
node tools/sinain-bridge/test-toml-adapters.mjs    # TOML family
node tools/sinain-bridge/test-plugin-adapters.mjs  # plugin family
```
