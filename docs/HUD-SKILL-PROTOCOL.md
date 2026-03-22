# HUD Skill Protocol

The AI agent communicates with the overlay using a structured message format. sinain-core parses these tags from agent responses and routes them to the overlay via WebSocket.

## Message Format

```
[HUD:feed priority=<normal|high|urgent>] <message>
[HUD:silent]
[HUD:pong]
```

## Priority Semantics

| Priority | Meaning |
|---|---|
| `normal` | Helpful info, no time pressure |
| `high` | User needs this in the next 30 seconds |
| `urgent` | About to make a mistake or miss something critical |

## Silence Protocol

Silence is a valid response. `[HUD:silent]` suppresses output when the agent has nothing useful to add. The agent should prefer silence over low-value messages — the overlay is a limited display surface.

## Pong

`[HUD:pong]` is the response to a health-check ping from sinain-core. It confirms the agent session is alive without producing visible output.
