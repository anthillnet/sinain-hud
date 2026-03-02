# HEARTBEAT.md

> **Execution contract:**
> 1. Setup → call `sinain_heartbeat_tick` → act on result → HEARTBEAT_OK
> 2. You MUST call the tool. Do NOT skip it. Do NOT reply HEARTBEAT_OK without calling it first.

---

## Setup

1. `sessions_history({ sessionKey: "agent:main:sinain", limit: 20, includeTools: false })`
2. Determine **IDLE** status: no user activity in the last 30 minutes
3. Compose **SESSION_SUMMARY**: 2–3 sentences describing the current state (what the user is doing, key topics, errors seen)

---

## Execute Tick

Call the `sinain_heartbeat_tick` tool:

```
sinain_heartbeat_tick({ sessionSummary: "...", idle: true|false })
```

The tool runs all scripts (git backup, signal analysis, insight synthesis) and writes the log entry automatically.

---

## Act on Result

- If `recommendedAction.action === "sessions_spawn"` → spawn a subagent with `.task`
- If `recommendedAction.action === "telegram_tip"` → send `.task` to Telegram
- If `output` is not null → send to Telegram: `Suggestion: {suggestion}\n\nInsight: {insight}`

---

## Finish

Reply **HEARTBEAT_OK**

---

## Rules

- **Proactivity quota:** on active days, at least 2 ticks MUST produce output
- Max 2 subagents. NEVER repeat a recent action. Prefer depth over breadth.
- Memory mining, feedback, and curation run via plugin timer — do NOT invoke manually.
- Module management is on-demand, not per-tick — see SKILL.md for module commands.
