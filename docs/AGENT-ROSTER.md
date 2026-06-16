# Agent Roster & Profiles

Sinain runs your context through a chosen agent — Claude Code, OpenClaude, an
OpenClaw gateway, or any custom variant you define. Which agent handles
escalations and spawn tasks is a *runtime* choice you make in the overlay.
The set of agents available to choose from is a *static* config you keep in
`agents.json`. This doc covers both.

## Mental model

There are two layers, and conflating them is the most common source of
confusion.

| Layer | What it is | Where it lives | Who edits it |
|---|---|---|---|
| **Roster** | The list of *available* profiles | `~/.sinain/agents.json` | You (via wizard or hand-edit) |
| **Lane choice** | Which profile is *currently active* per lane | sinain-core memory (in-flight) | You via overlay flash icon |

The roster is the menu; the lane choice is the order. Sinain has two lanes:

- **Escalation lane** — handles HUD escalations (the agent that responds when
  sinain detects you might benefit from advice)
- **Spawn lane** — handles user-initiated background tasks (Shift+Enter from
  the overlay)

Both lanes can pick independently. Either can be set to **Off**, which
disables that lane entirely.

The flash icon in the overlay's controls bar opens the **AgentSelectorPanel**
popover where you pick. The chosen agent for each lane gets piggybacked on
the bare agent's existing poll responses — no kill-and-restart, switching
takes effect on the next escalation/spawn cycle.

## Where the config lives

```
~/.sinain/agents.json                   ← your local working copy (gitignored,
                                          wizard's write target)
sinain-agent-runner/agents.example.json        ← committed template (in the repo /
                                          npm package)
```

### Path resolution priority (sinain-core + run.sh)

1. `AGENTS_CONFIG_PATH` env var — explicit override, useful for tests or
   custom layouts.
2. `~/.sinain/agents.json` — wizard's write target. Highest non-explicit
   priority; works on npm installs where the package directory is read-only.
3. `<repo-root>/sinain-agent-runner/agents.json` — legacy / dev-repo location.
4. `<repo-root>/sinain-agent-runner/agents.example.json` — bootstrap fallback.

### First-run bootstrap

If neither (2) nor (3) exists, `run.sh` copies `agents.example.json` into the
first writable target — typically `~/.sinain/agents.json` for npm-installed
users, `sinain-agent-runner/agents.json` for repo dev installs. After bootstrap,
edit your working copy freely; the example template stays untouched.

## Schema

Top-level fields and a `profiles` block. Every field except `profiles[name].type`
is optional.

```jsonc
{
  // ─── Top-level: bare-agent infra ───
  "default":           "openclaude",          // boot-time default lane
  "pollIntervalSec":   5,                      // bare-agent poll cadence
  "agentMaxTurns":     8,                      // max tool-use turns per escalation
  "spawnMaxTurns":     25,                     // max tool-use turns per spawn
  "allowedTools":      "mcp__sinain",          // base whitelist (--allowedTools)
  "escAllowedTools":   "${allowedTools} Bash(git:*) Edit Write Read Glob Grep LS",
  "spawnAllowedTools": "${allowedTools} Bash(git:*) Edit Write Read Glob Grep LS",
  "autoApproveTools":  "Read Glob Grep Ls Cat mcp__sinain*",

  // ─── Analyzer loop pacing (sinain-core) ───
  "analyzer": {
    "debounceMs":      6000,
    "maxIntervalMs":   60000
  },

  // ─── Escalation policy (sinain-core) ───
  "escalation": {
    "mode":            "rich",                 // off | selective | focus | rich
    "cooldownMs":      30000,
    "staleMs":         90000
  },

  // ─── Roster: one entry per profile ───
  "profiles": {
    "claude":     { "type": "claude" },
    "openclaude": {
      "type":  "openclaude",
      "model": "deepseek/deepseek-v4-flash",
      "env":   {
        "CLAUDE_CODE_USE_OPENAI": "1",
        "OPENAI_BASE_URL":        "http://localhost:11435/api/v1",
        "OPENAI_API_KEY":         "${OPENROUTER_API_KEY}"
      }
    },
    "openclaw": {
      "type":            "openclaw",
      "wsUrl":           "ws://localhost:18789",
      "wsToken":         "${OPENCLAW_WS_TOKEN}",
      "httpUrl":         "http://localhost:18789/hooks/agent",
      "httpToken":       "${OPENCLAW_HTTP_TOKEN}",
      "sessionKey":      "agent:main:sinain",
      "phase1TimeoutMs": 30000,
      "phase2TimeoutMs": 120000,
      "pingIntervalMs":  30000
    },
    "codex":  { "type": "codex" },
    "goose":  { "type": "goose" },
    "junie":  { "type": "junie" },
    "aider":  { "type": "aider" },
    "hermes": { "type": "hermes" }
  }
}
```

### Profile fields

| Field | Required | Used for |
|---|---|---|
| `type` | yes | Determines dispatch path AND CLI flag layout. See [Profile types](#profile-types) below. |
| `bin` | no | Path or name of a real binary on PATH (default: profile name). **Shell aliases are invisible** — see [aliases](#shell-aliases-arent-binaries). |
| `settings` | no | Path to a Claude-Code-style `settings.json` (default: `sinain-agent-runner/.claude/settings.json` — the hook-bearing one). |
| `model` | no | `OPENAI_MODEL` override; only meaningful for `CLAUDE_CODE_USE_OPENAI=1` paths (e.g. openclaude). |
| `env` | no | Per-profile env overrides applied only for this profile's invocation. Values may use `${VAR}` indirection (anywhere in the string). |

### Gateway-only fields (`type: "openclaw"` profiles)

Consumed by sinain-core, not run.sh:

| Field | Used for |
|---|---|
| `wsUrl` | Gateway WebSocket endpoint |
| `wsToken` | WS auth token (typically `${OPENCLAW_WS_TOKEN}` from `.env`) |
| `httpUrl` | Gateway HTTP hooks endpoint |
| `httpToken` | HTTP auth token |
| `sessionKey` | Multi-session routing key (default: `agent:main:sinain`) |
| `phase1TimeoutMs` | Accept-frame timeout (default: 30000) |
| `phase2TimeoutMs` | Final-frame timeout (default: 120000) |
| `pingIntervalMs` | WS keepalive (default: 30000) |

## Profile types

The `type` field is the dispatch contract. Two families:

### Local CLIs (HTTP-dispatched)

| Type | Notes |
|---|---|
| `claude` | Calls sinain MCP tools directly. Recommended default. |
| `openclaude` | Open-source Claude Code clone. Routes through OpenAI-compat endpoints (Ollama, OpenRouter via the auto-launched proxy on `:11435`, custom endpoints). |
| `codex` | OpenAI Codex CLI. MCP support via `codex mcp add`. |
| `goose` | Block's Goose. MCP support via `extensions:` block. |
| `junie` | JetBrains Junie. MCP support via `--mcp-location` (newer versions). |
| `aider` | Pipe mode only — receives escalation text on stdin, writes response to stdout. |
| `hermes` | NousResearch [Hermes](https://github.com/NousResearch/Hermes-Agent) — the evolution of OpenClaw, but it dropped OpenClaw's WS RPC contract, so it's dispatched as a *local CLI*, **not** a gateway. Pipe mode by default (`hermes -z`); opt-in MCP mode with `HERMES_USE_MCP=true`. See [Hermes: pipe vs MCP mode](#hermes-pipe-vs-mcp-mode). |

For local CLIs, the bare agent (`run.sh`) invokes the binary on each
escalation/spawn. The `bin` field selects which executable to run; defaults
to the profile name.

### Gateway profiles (WS-dispatched)

| Type | Notes |
|---|---|
| `openclaw` | OpenClaw or any compatible fork (NemoClaw, NanoClaw, etc.) |

For gateway profiles, sinain-core sends escalations and spawn tasks via WS
RPC to the URL defined in the profile's `wsUrl`. The bare agent never
invokes a binary — gateway profiles have no `bin`.

> **Multiple gateway profiles**: Any number of profiles can declare
> `type: "openclaw"`, with their own URLs. They all appear in the overlay
> roster. Today only the *first* gateway profile gets a live WS client at
> startup; selecting a different gateway profile for a lane routes via WS
> but the connection still uses the first profile's URL. True per-profile
> WS clients (one client per gateway URL, lazy construction on selection)
> is a planned follow-up.

### Hermes: pipe vs MCP mode

[Hermes](https://github.com/NousResearch/Hermes-Agent) is NousResearch's
self-improving agent — the evolution of OpenClaw. **It does not speak
OpenClaw's WS RPC protocol** (Hermes moved to a one-shot CLI / MCP / ACP
surface), so despite the lineage it is *not* a `type: "openclaw"` gateway.
It slots into the local-CLI lane via its headless one-shot flag, `-z/--oneshot`,
which prints only the final response to stdout and auto-bypasses tool
approvals (so it never hangs waiting on a TTY).

It runs in one of two modes:

| Mode | When | How it works |
|---|---|---|
| **Pipe** (default) | `HERMES_USE_MCP` unset | `run.sh` polls the escalation, hands Hermes the full message text (`hermes -z "$msg"`), captures stdout, and POSTs the response. The escalation already carries screen/audio/digest context, so Hermes answers as a self-contained oracle using its own model, memory, and skills (set via `hermes model` / `hermes setup`). No sinain MCP registration needed. |
| **MCP** (opt-in) | `HERMES_USE_MCP=true` | `run.sh` registers `sinain-mcp-server` into `~/.hermes/config.yaml` (`mcp_servers`) at startup and routes through the MCP path, so Hermes calls `sinain_respond` / `sinain_knowledge_query` itself — mirroring the `claude` flow. Requires Hermes' headless tool-approval to be configured. |

**Setup.** Install Hermes (`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`, or clone + `./setup-hermes.sh`), then `hermes model` to pick a provider/model. Once `hermes` is on your `PATH`, the `hermes` profile appears in the overlay roster automatically — it's a built-in 1:1 profile, no `agents.json` edit required.

**Latency note.** In pipe mode Hermes runs its full agentic loop — bounded by
`max_turns` in `~/.hermes/config.yaml` (which defaults high; check your
installed value) — per escalation, so a complex one can take longer / cost
more than a single LLM call. Lower `max_turns` or restrict the toolset (`-t`)
if HUD responsiveness matters.

## Shell aliases aren't binaries

If you have an alias like `pclaude=CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude`
in your `~/.zshrc`, **it's invisible to `run.sh`** — the bare agent starts a
non-interactive bash that never sources your rc file. Aliases live only in
interactive shell sessions.

To use an aliased setup, replicate it as a profile entry: real `bin` +
`env` block.

```jsonc
"pclaude": {
  "type": "claude",
  "bin":  "claude",                          // the real PATH binary, not the alias
  "env":  {
    "CLAUDE_CONFIG_DIR": "${HOME}/.claude-personal"
  }
}
```

## `${VAR}` indirection

Profile values may use `${VAR}` syntax to read from the parent shell's
environment — keep secrets in `~/.sinain/.env`, not in `agents.json`.

There are two passes:

1. **Cross-field literal expansion** (top-level only): a value like
   `"${allowedTools} Bash(git:*) Edit"` resolves `${allowedTools}` against
   another top-level field of the same JSON. Lets you compose whitelists.
2. **Env-var expansion** (anywhere in any string field): `${OPENROUTER_API_KEY}`,
   `${HOME}`, `${OPENCLAW_WS_TOKEN}` resolve against `process.env` (sinain-core)
   or the parent shell's environment (`run.sh`).

Both passes only handle braced `${...}` references. Bare `$VAR` and `$(cmd)`
are left literal — defensive against typos that could otherwise execute
arbitrary commands.

## Routing decision

When sinain-core dispatches an escalation or spawn task, it consults the
*current lane choice* (escalation lane for escalations, spawn lane for
spawns) and looks up that profile's `type`:

```
┌─ profile.type === "openclaw" ─────────► WS dispatch (gateway)
├─ profile.type is anything else, set ──► HTTP dispatch (bare agent polls)
└─ lane is empty (Off) ─────────────────► drop
```

Agent identity *is* the transport. The previous global `ESCALATION_TRANSPORT`
setting was removed — picking openclaw vs a local agent in the overlay
selector determines WS vs HTTP, not a separate config knob.

### Edge cases

- **Gateway selected, WS down**: the escalation is dropped with a
  high-priority toast on the HUD ("⚠ Gateway disconnected — escalation
  dropped..."). No silent fallback to the bare agent — that fallback
  caused infinite skip loops because the bare agent can't run
  `openclaw` as a CLI.
- **Lane switches mid-flight**: an escalation queued for HTTP gets
  *redispatched* through the WS slot when the lane flips local → gateway,
  so the in-flight question is honored under the new choice.
- **Profile referenced by lane but missing from roster**: the
  selector rejects the choice with `"Agent X not available"` — stale
  overlay state can't slip past the validator.

## Per-lane selection (overlay UX)

Tap the **flash icon** in the overlay's controls bar:

```
┌──────────────────────────────────────┐
│ AGENTS                            [×]│
├──────────────────────────────────────┤
│ ESCALATION                           │
│ [Off] [claude*] [openclaude] [openclaw] [codex] │
├──────────────────────────────────────┤
│ SPAWN                                │
│ [Off] [claude] [openclaude*] [openclaw]         │
└──────────────────────────────────────┘
```

Selected chips show in accent color. Each lane updates independently. The
selection persists in sinain-core memory (resets on core restart; the bare
agent re-announces its roster on startup so things heal automatically).

The flash icon dims to white-30% when the lane is **Off** OR when the
roster is empty (no agents installed and no gateway configured).

## Recipes

### Add a personal Claude with its own config dir

```jsonc
"pclaude": {
  "type": "claude",
  "bin":  "claude",
  "env":  { "CLAUDE_CONFIG_DIR": "${HOME}/.claude-personal" }
}
```

`pclaude` shows up in the roster. Selecting it for a lane runs `claude`
with `CLAUDE_CONFIG_DIR` exported to that subshell — your personal config
applies for that invocation, your team config stays in place for others.

### Add a server-side NemoClaw alongside the canonical openclaw

```jsonc
"nemoclaw": {
  "type":            "openclaw",
  "wsUrl":           "ws://nemoclaw-host:18789",
  "wsToken":         "${NEMOCLAW_WS_TOKEN}",
  "httpUrl":         "http://nemoclaw-host:18789/hooks/agent",
  "httpToken":       "${NEMOCLAW_HTTP_TOKEN}",
  "sessionKey":      "agent:main:sinain"
}
```

Both `openclaw` and `nemoclaw` appear in the roster; selecting either
routes via WS. Set `NEMOCLAW_WS_TOKEN` and `NEMOCLAW_HTTP_TOKEN` in
`~/.sinain/.env`.

### Two openclaude variants pointing at different OpenRouter routes

```jsonc
"openclaude":         { "type": "openclaude", "model": "deepseek/deepseek-v4-flash",
                        "env": { "CLAUDE_CODE_USE_OPENAI": "1",
                                 "OPENAI_BASE_URL": "http://localhost:11435/api/v1",
                                 "OPENAI_API_KEY":  "${OPENROUTER_API_KEY}" } },
"openclaude-gpt5":    { "type": "openclaude", "bin": "openclaude",
                        "model": "openai/gpt-5",
                        "env":   { "CLAUDE_CODE_USE_OPENAI": "1",
                                   "OPENAI_BASE_URL": "http://localhost:11435/api/v1",
                                   "OPENAI_API_KEY":  "${OPENROUTER_API_KEY}" } }
```

Pick `openclaude` for rapid escalations (DeepSeek's reasoning), pick
`openclaude-gpt5` for spawn tasks where higher-tier reasoning matters.

### Different `settings.json` for spawn vs escalation

```jsonc
"openclaude":       { "type": "openclaude" },
"openclaude-spawn": {
  "type":     "openclaude",
  "bin":      "openclaude",
  "settings": "/Users/me/IdeaProjects/sinain-hud/sinain-agent-runner/.claude/spawn-settings.json"
}
```

Pick `openclaude` for the escalation lane (default settings.json with
hook-bearing tool whitelist), `openclaude-spawn` for the spawn lane
(separate file with widened YOLO tools).

## Wizard interaction

The setup wizard (`npx @geravant/sinain start --setup` or
`npx @geravant/sinain config`) writes the openclaw profile + escalation
mode + default agent to `~/.sinain/agents.json`. Tokens go to
`~/.sinain/.env`. The wizard *patches* — it preserves any custom profiles
you've added between runs. Running it again to update the gateway URL
won't blow away your `pclaude` or `nemoclaw` entries.

The "Skip / Disable" choice in the gateway step deletes the openclaw
profile from `agents.json`, which removes openclaw from the roster and
disables the gateway WS client at sinain-core startup.

## Troubleshooting

**Profile doesn't appear in the overlay roster.**
- Local CLI: `run.sh` filters by `command -v <bin>` — make sure the binary
  is on the PATH that the bare agent sees. Test: `bash -c 'command -v <bin>'`
  in a *fresh* terminal (not the one you defined an alias in).
- Gateway profile: `agents.example.json` ships with `openclaw` defined; if
  the wizard "skipped" it, the profile got deleted. Re-run `sinain config`
  and pick Local or Remote.

**Selecting `openclaw` produces "⚠ Gateway disconnected" on the HUD.**
- The WS client couldn't reach the gateway URL. Check `wsUrl` in your
  openclaw profile, verify the gateway is running on that port, and that
  the WS token in `${OPENCLAW_WS_TOKEN}` matches the gateway's expected
  token.
- Sinain-core logs show `[escalator] gateway agent "openclaw" selected
  but WS disconnected` when this fires.

**Bare agent log says `Escalation X skipped — gateway agent 'Y' is
WS-routed`.**
- A stale escalation from before the most recent lane switch. The bare
  agent is correctly refusing to handle a gateway-tagged escalation. The
  next escalation tick should route via WS as expected. If it persists,
  restart sinain-core to clear the in-memory `httpPending` slot.

**`agents.json` deleted by accident.**
- Restart `run.sh`. The bootstrap recreates it from
  `agents.example.json`. Your custom profiles are gone (they only lived
  in your local copy), but defaults work again.

**Wizard wrote my prod gateway URL into `agents.example.json`.**
- That shouldn't happen — the wizard targets `~/.sinain/agents.json`, not
  the example file. If you see prod values in
  `sinain-agent-runner/agents.example.json`, you may have manually edited the
  template; revert it from git: `git checkout sinain-agent-runner/agents.example.json`.

## Reference: contracts that key off `type`

For implementers / debuggers, the type-based contract is consumed at
several layers — useful to know if you're ever tracing why a profile
behaves a certain way:

| Layer | File | What it does |
|---|---|---|
| Roster injection | `sinain-core/src/index.ts:registerBareAgent` | Adds every gateway-typed profile name to the broadcast roster |
| Dispatch routing | `sinain-core/src/escalation/escalator.ts:dispatchEscalation/dispatchSpawnTask` | Calls `isGatewayAgent(name)` → WS vs HTTP |
| WS connection params | `sinain-core/src/config.ts` (uses `findGatewayProfile`) | First openclaw-typed profile's URLs become `openclawConfig` |
| Roster (bare agent side) | `sinain-agent-runner/run.sh` | Skips PATH-existence filter for openclaw-typed profiles |
| Defensive skip guard | `sinain-agent-runner/run.sh` | Bare agent refuses to invoke when `prof_get_or "$ESC_AGENT" type` is `openclaw` |
| MCP detection | `sinain-agent-runner/run.sh:agent_has_mcp` | Routes claude/openclaude/codex/goose via MCP path; junie conditional; hermes via pipe by default (MCP when `HERMES_USE_MCP=true`); aider/openclaw via pipe path |

All five layers consult `agents.json` (or its loaded view) — a single
source of truth.
