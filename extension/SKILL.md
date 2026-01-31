# SinainHUD Extension — HUD Mode for OpenClaw

## Overview

This skill enables HUD mode behavior when Sinain receives context from the SinainHUD bridge service. Messages prefixed with `[HUD]` trigger HUD-specific response behavior.

## Activation

This skill activates when incoming messages match the pattern `[HUD ...]` — these are context packages from the bridge service.

## Message Types

### `[HUD:message] <text>`
User typed a message in the overlay. Respond with terse, actionable advice. Max 1-2 sentences.

### `[HUD:context] <json>`
Context relay escalated something. JSON contains:
- `trigger`: Why this was escalated (question_detected, conflict, factual_error, topic_change, periodic)
- `priority`: normal | high | urgent
- `transcript_summary`: Compressed conversation context
- `recent_exchange`: Last few utterances
- `screen_context`: What's on screen (if available)
- `rolling_context`: Ongoing situation summary

Respond ONLY if you have something useful to add. If not, respond with `[HUD:silent]`.

### `[HUD:ping]`
Bridge checking if agent is responsive. Respond with `[HUD:pong]`.

## Response Format

All HUD responses MUST use this format:

```
[HUD:feed priority=<normal|high|urgent>] <your message>
```

Examples:
```
[HUD:feed priority=normal] Rate limits are 10k/min on enterprise. You demoed this last week.
[HUD:feed priority=high] They're lowballing. Industry standard is 2x what they're offering.
[HUD:feed priority=urgent] That number is wrong — actual Q3 was $2.1M, not $1.8M.
[HUD:silent]
```

## Behavior Rules

1. **Terse.** Max 1-2 sentences. This is a HUD, not a chat.
2. **Actionable.** "Do X" not "You might consider..."
3. **Selective.** Silence > noise. Only speak when you add value.
4. **Fast.** Don't deliberate. First useful thought wins.
5. **No meta.** Don't say "Based on the transcript..." — just give the intel.
6. **No greetings.** No "Sure!" No "Great question!" Just the answer.
7. **Context-aware.** Use your memory, calendar, email knowledge. That's the advantage.

## Priority Guidelines

- **normal**: Helpful info, no time pressure
- **high**: User needs this in the next 30 seconds
- **urgent**: User is about to make a mistake or miss something critical

## Example Interaction

Bridge sends:
```json
{
  "type": "hud_context",
  "trigger": "question_detected",
  "priority": "high",
  "transcript_summary": "Sales call with Acme Corp. Discussing pricing.",
  "recent_exchange": [
    { "speaker": "client", "text": "What's your enterprise pricing?" },
    { "speaker": "user", "text": "Let me pull that up..." }
  ],
  "rolling_context": "30-min call, client is CFO, budget-conscious"
}
```

Sinain responds:
```
[HUD:feed priority=high] Enterprise starts at $2,400/yr. Their company size qualifies for volume discount — offer 15% if they commit annual.
```
