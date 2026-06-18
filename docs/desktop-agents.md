# Open a region in Claude Desktop or ChatGPT

Sinain can hand a selected screen region (ROI) to a desktop AI app and let it
help you with it — alongside the built-in chat sidecar and terminal agents.

Pick **Claude Desktop** or **ChatGPT** as the chat-lane agent, select a region,
and tap **Chat**. Sinain composes the region's context and the desktop app pulls
it in and helps — it doesn't just describe the screen.

## How it works

One context, one delivery mechanic for every agent (terminal, Claude Desktop,
ChatGPT):

1. You select a region and start a chat.
2. Sinain composes a **rich seed** — the region, its on-screen text (OCR), the
   current situation digest, and relevant long-term knowledge — and stores it
   under a one-time id. (The launch is instant; knowledge is added in the
   background a moment later.)
3. The app opens on a short pointer ("load the context for what I'm working on")
   and pulls the seed via the **`sinain_roi`** MCP tool. Nothing rides the URL,
   so there's no size limit and no screen content in the link.

Agents are selectable in the chat-lane roster and appear **only when the app is
installed**.

## Setup

### Claude Desktop (local, no network exposure)
Add sinain's MCP server to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
"sinain": {
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/sinain-mcp-server/dist/index.js"],
  "env": { "SINAIN_CORE_URL": "http://localhost:9500" }
}
```

Restart Claude Desktop. The first `sinain_roi` call prompts for approval — choose
**Always allow**. (If a tool call ever "times out", the MCP server process died —
relaunch Claude Desktop and it respawns.)

### ChatGPT (remote — off by default, security-sensitive)
ChatGPT only accepts **remote** MCP connectors over public HTTPS, so it requires
exposing sinain's MCP server through a tunnel. This is **off by default** behind a
settings toggle:

> **Settings → ChatGPT network harness** — ⚠ *Opens a public tunnel to your local
> context (screen/audio). Anyone with the URL could reach it. Enable only while
> using ChatGPT, and turn it off when done.*

When enabled, run the MCP server in HTTP mode, expose it over an HTTPS endpoint you
control, and add that URL as a connector in the ChatGPT web app (Developer mode).
Treat the endpoint like a password and shut the tunnel when finished.

## Notes

- **Auto-send** uses a synthesized keystroke and needs macOS **Accessibility**
  permission for the process running sinain-core; without it, the app still opens
  pre-filled and you press Enter.
- The chat-lane agent is **global** today (all regions use the selected agent);
  per-region agent selection is a planned follow-up.
