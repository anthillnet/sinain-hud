# Design: Make "Idle Messages Off" persist (stop re-register from resuming escalation)

- **Status:** Proposed
- **Author:** (handoff from sinain-hud investigation, 2026-06-17)
- **Scope:** `sinain-core` escalation lifecycle + overlay agent-selector toggle
- **Target:** implement in the canonical sinain-core repo (paths below are illustrative; line numbers from the investigated tree)

---

## 1. Problem

Turning **IDLE MESSAGES → Off** in the overlay does not stick. Ambient (idle, `score=0`) escalations keep firing within seconds of toggling off.

Symptom reported by the user: "idle escalations are still flowing despite the toggle being OFF." Reproduces on the real core, independent of the PoC mock-core.

## 2. Root cause

Escalation has **two pieces of state** that both encode "off-ness," and a roster-healing path that conflates a *user-intended* pause with a *stale boot config*.

State today:

| State | Meaning | Set by |
|---|---|---|
| `escalationConfig.mode` (`off`/`selective`/`focus`/`rich`) | Gates `shouldEscalate()` — the real loop kill-switch | `escalator.setMode()` |
| `bareAgentState.escalationAgent` (`""` = Off, else agent name) | Gates **dispatch** only (`"lane is Off"`) | `set_agent` |
| `savedEscalationMode` (`null` \| prior mode) | Remembers pre-pause mode; **non-null ⇔ user-initiated pause is active** | `pauseEscalationInternal()` sets it; `resumeEscalationInternal()` clears it |

Flow when the user turns idle messages off:

1. Overlay `IDLE MESSAGES → Off` sends `toggle_escalation`.
2. `onToggleEscalation` → `pauseEscalationInternal()` → `escalator.setMode("off")`, and caches `savedEscalationMode = "rich"`.
3. The escalation **agent stays selected** (e.g. `openclaude`) — the idle toggle changes *mode*, not the agent.

Then the **bare agent re-registers** (it does so very frequently — observed dozens of `bareagent register …` events over a session, every few minutes, as a roster-healing mechanism). `registerBareAgent()` ends with:

```js
// sinain-core/src/index.ts (~1257)
// "If a lane is set but mode is still off (e.g. an old wizard run wrote mode=off and
//  the user has since picked an agent) … reconcile by promoting mode to match."
if (bareAgentState.escalationAgent && config.escalationConfig.mode === "off") {
  resumeEscalationInternal();   // ← turns escalation back ON
}
```

Because the agent is non-empty **and** mode is `off`, this reconciliation fires and **resumes** escalation — undoing the user's pause. The high re-registration frequency makes the pause revert within seconds.

### Why it's a real conflation

`{ escalationAgent set, mode === "off" }` legitimately means **two different things**:

- **(a) Stale/boot config** — agents.json or an old wizard wrote `mode=off` while an agent is selected. Here, auto-resuming is *correct*.
- **(b) Deliberate user pause** — the user turned idle messages off via the toggle while keeping an agent selected. Here, auto-resuming is *wrong*.

The reconciliation at line 1257 cannot distinguish them, so it clobbers (b).

### Corroborating evidence

- `backend.log` shows many `bareagent register … esc=openclaude` lines and **zero surviving** `escalation paused` lines — consistent with every pause being immediately resumed.
- The `set_agent("escalation","")` path and the `toggle_escalation` path both route through `pauseEscalationInternal()`, so the bug affects *both* "agent → Off" and "idle messages → Off."

## 3. Goals / Non-goals

**Goals**
- A user's "idle messages off" survives bare-agent re-registration (within a session).
- Preserve the legitimate boot/stale reconciliation (case **a**).
- Keep "no resources when not in use" — paused means the loop truly does not escalate.

**Non-goals (call out, decide separately)**
- Cross-process-restart persistence of the pause (see §4, Option B / open question).
- Reworking the chat/terminal lane model.

## 4. Proposed design

### Primary fix — disambiguate user-pause from stale-config

`savedEscalationMode` is already the exact discriminator we need: it is **non-null only while a user-initiated pause is active** (`pauseEscalationInternal` sets it, `resumeEscalationInternal` clears it). A fresh boot / stale-config `mode=off` leaves it `null`.

Gate the re-register auto-resume on it:

```js
// only reconcile a STALE config; never override a deliberate pause
if (bareAgentState.escalationAgent
    && config.escalationConfig.mode === "off"
    && savedEscalationMode === null) {       // ← added condition
  resumeEscalationInternal();
}
```

Behavior matrix after the fix:

| Situation | `mode` | `savedEscalationMode` | Re-register action |
|---|---|---|---|
| User paused idle messages | `off` | non-null | **leave paused** ✅ |
| Stale/boot: agents.json `off` + agent set | `off` | `null` | auto-resume (reconcile) ✅ |
| Normal active | `rich`/… | `null` | no-op ✅ |

This is a one-line guard, fully contained in `registerBareAgent`, and reuses existing state — no new fields.

### Secondary fix — explicit set semantics for the toggle (overlay)

Both `On` and `Off` chips currently call the **same** `toggle_escalation` (a flip, not a set):

```dart
_chip(label: 'On',  onTap: () => ws.sendCommand('toggle_escalation')),
_chip(label: 'Off', onTap: () => ws.sendCommand('toggle_escalation')),
```

If the displayed state ever desyncs from core, tapping flips the wrong way. Make them idempotent setters:
- `On`  → `set_escalation_enabled true` (resume)
- `Off` → `set_escalation_enabled false` (pause)

Add a core command that maps directly to `resumeEscalationInternal()` / `pauseEscalationInternal()` (the existing `toggle_escalation` can stay for back-compat). Idempotent set removes the flip-on-desync class of bug.

### Option B (larger, recommended if restart-persistence matters)

Introduce an explicit, **persisted** user-intent flag, e.g. `idleMessagesEnabled: boolean`, decoupled from `mode`:

- Escalation gate = `mode-derived` **AND** `idleMessagesEnabled`.
- Re-register reconciliation only ever touches `mode` for the stale-boot case; it never reads/writes `idleMessagesEnabled`.
- Persist `idleMessagesEnabled` (same place per-lane agent selection or wizard config is stored) so the pause survives a core restart.

Trade-off: removes the overloaded-state root cause entirely and adds restart durability, at the cost of a new persisted field + migration. The Primary fix is the minimal in-session correctness fix; Option B is the clean long-term model.

## 5. Open question

Should "idle messages off" survive a **core restart**? Today `mode` and `savedEscalationMode` are in-memory, so any restart re-reads `escalationConfig.mode` from config (default `rich`) and escalation resumes regardless of the fix. If persistence is desired, Option B (persisted `idleMessagesEnabled`) is required. Recommend deciding this explicitly before implementing.

## 6. Test plan

1. **Unit (escalator/register):** with `escalationAgent` set + `mode="off"` + `savedEscalationMode` non-null, `registerBareAgent` must NOT resume. With `savedEscalationMode === null`, it MUST resume.
2. **Integration:** toggle idle messages off → fire N synthetic `/bareagent/register` POSTs → assert `mode` stays `off` and no `escalating tick` is logged.
3. **Regression (boot reconcile):** boot with agents.json `mode=off` + an agent selected → assert escalation resumes (case a preserved).
4. **Overlay:** with explicit set chips, tapping `Off` twice keeps it off; tapping `On` resumes; verify against a deliberately desynced displayed state.
5. **Soak:** idle messages off for 10+ min across the normal re-register cadence → zero idle escalations dispatched.

## 7. Files (in the canonical sinain-core)

- `sinain-core/src/index.ts` — `registerBareAgent()` auto-resume guard (~line 1257); `pauseEscalationInternal`/`resumeEscalationInternal` (~1135–1153); `onToggleEscalation`/`onSetAgent` handlers (~1857–1927); new `set_escalation_enabled` command if adopting the secondary fix.
- `sinain-core/src/escalation/escalator.ts` — `setMode()` (~315); `shouldEscalate` gate (~359).
- `overlay/lib/ui/settings/agent_selector_panel.dart` — IDLE MESSAGES chips (~86–98).
