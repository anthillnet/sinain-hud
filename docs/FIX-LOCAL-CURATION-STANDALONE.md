# Fix: Local Curation Pipeline Works Without Agent Connection

## Problem

The local curation pipeline (`LocalCurationService`) is supposed to distill session observations into the knowledge system (`~/.sinain/memory/`) even when no OpenClaw agent is connected. Currently, it always skips with "only 0 feed items" because two problems compound:

1. **Escalation mode gate suppresses feed capture**: In `ESCALATION_MODE=rich` (the default), `agent/loop.ts:366-368` suppresses pushing agent HUD to the feed buffer. This gate conflates overlay display routing with data capture — it was meant to avoid cluttering the overlay (since rich mode routes through OpenClaw instead), but it also starves the curation pipeline.

2. **Threshold too high**: `local-curation.ts` requires >= 3 feed items. Even with audio, short sessions may not reach 3 items.

**Result**: The agent loop runs, analyzes screen+audio, produces valuable digests — but none of it reaches the feed buffer, so curation never fires.

## Root Cause

The escalation mode gate at `loop.ts:366` was designed to control **overlay display routing** (in rich mode, the overlay gets updates via OpenClaw escalation instead of direct HUD pushes). But it accidentally also gates **data capture** — the feed buffer push that the curation pipeline depends on. These are two separate concerns that should be decoupled.

## Fix

### Step 1: Decouple feed capture from overlay broadcast (`agent/loop.ts:365-374`)

Split the current combined block into two separate concerns:

```typescript
// BEFORE (single block, gated by escalation mode):
if (pushToFeed && mode !== "focus" && mode !== "rich" && hud is meaningful) {
  feedBuffer.push(...)    // data capture
  onHudUpdate(...)        // overlay broadcast
}

// AFTER (separated):
if (pushToFeed && hud is meaningful) {
  feedBuffer.push(...)    // always capture for curation
}
if (pushToFeed && mode !== "focus" && mode !== "rich" && hud is meaningful) {
  onHudUpdate(...)        // overlay broadcast only in non-escalation modes
}
```

This preserves overlay behavior (no HUD spam in rich/focus mode) while ensuring the feed buffer always captures agent output for the knowledge pipeline.

### Step 2: Lower curation threshold from 3 to 1 (`local-curation.ts`)

Change at 4 locations (lines 98, 138, 163, 335): `feedItems.length < 3` -> `feedItems.length < 1`

A single meaningful agent analysis is already worth distilling. The Python `session_distiller.py` can decide if content is too thin.

## Files to Modify

| File | Change |
|------|--------|
| `sinain-core/src/agent/loop.ts` | Lines 365-374: separate feed push from overlay broadcast |
| `sinain-core/src/learning/local-curation.ts` | Lines 98, 138, 163, 335: threshold 3 -> 1 |

## Files Unchanged (reference only)

- `sinain-core/src/index.ts` — shutdown flow at 793-808 already passes `feedBuffer.query(0)` to curation
- `sinain-core/src/types.ts` — FeedItem type already supports `source: "agent"`
- Python scripts (`session_distiller.py`, `knowledge_integrator.py`) — no changes needed

## Verification

1. `npx tsc --noEmit` — type-check passes
2. Run `npm run dev` with `ESCALATION_MODE=rich` and no OpenClaw connection
3. Generate some screen/audio activity, then Ctrl+C
4. Logs should show:
   - Agent loop ticks with HUD output (already works)
   - `[local-curation] saved N feed items to pending-session.json` (N >= 1)
   - `[local-curation] distilling session...` (instead of "skipping save")
5. Check `~/.sinain/memory/YYYY-MM-DD.md` for session notes
