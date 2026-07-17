# sinain-bridge

`sinain-bridge` forwards Claude Code lifecycle hook events to the local sinain-core hub. Permission requests wait for a hub decision; all other events are best-effort and never interrupt Claude Code.

Install or refresh the managed Claude Code hooks:

```bash
node tools/sinain-bridge/install-claude.mjs
```

Remove only the managed hooks:

```bash
node tools/sinain-bridge/install-claude.mjs --uninstall
```

Add `--dry-run` to preview either operation. `SINAIN_HOST` and `SINAIN_PORT` select the hub (defaults: `127.0.0.1:9500`). `CLAUDE_SETTINGS` overrides the settings file used by the installer, which otherwise uses `~/.claude/settings.json`.

Lifecycle events are posted to `/agent/event` with a short timeout. `PermissionRequest` is posted to `/agent/approve` and may wait up to 130 seconds. A successful `allow`, `deny`, or `always` decision is emitted in Claude Code's hook-output format. The output `{"decision":"ask"}` is the sentinel used when the hub says `ask` or cannot answer, telling Claude Code to show its own permission prompt.
