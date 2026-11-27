# Sinain interactive first-start demo — design brief

## Decision in one sentence

After setup, offer a **two-minute, hands-on guided tour** in a safe demo workspace: the user completes one small real-world task while Sinain reveals context capture, AI help, agent handoff, memory, and privacy controls at the moment each becomes useful.

This replaces neither setup nor the existing feature walkthrough. Setup earns permissions and configures a provider; this experience earns understanding and confidence through doing.

## Why this format

Sinain is not one feature. Its value is the connected loop:

```text
notice useful context → choose what to capture → get an informed answer
→ continue with an agent → retain the useful result → stay in control of privacy
```

A sequence of feature cards can describe each part, but cannot teach the interaction model: Sinain observes ambient work, the user explicitly chooses an action, and the chosen context travels with the task. The tour should let the user feel that loop once, without requiring their real work, account data, or a working agent installation.

## Goals and guardrails

| Goal | Design consequence |
|---|---|
| Make the product model clear | Use one continuous scenario, not a menu of unrelated tricks. |
| Demonstrate breadth without cramming | The core path has four interactions; remaining capabilities are short, optional reveals. |
| Build privacy trust before requesting behavior | Say what the tour uses and does not use before the first contextual action. |
| Avoid a fake product demo | The HUD, selection, context card, chat, and handoff controls should be the real components where available. Demo content may be seeded. |
| Preserve user agency | Every action has Skip, exit, and a visible reason; never auto-send to an agent or save a memory item. |
| Finish quickly | Aim for 100–120 seconds for the core path; no step should block progress while an AI response is pending. |

### Non-goals

- It is not a permissions wizard, pricing pitch, benchmark claim, or exhaustive manual.
- It must not capture, store, share, or transmit the user’s actual screen/audio/clipboard as part of the demo.
- It must not imply every agent integration is already installed. Where an agent is unavailable, demonstrate the portable context seed and name the next setup step.

## Entry, exit, and state

### When it appears

Show the invitation once after the first-run setup has completed and the product is ready enough to display the HUD. It should appear before the normal post-setup feature tour. The user chooses:

- **Take the 2-minute tour** — opens demo workspace and starts the guided path.
- **Explore on my own** — dismisses it; the full feature tour/help remains available later.

The invitation needs a plain-language disclosure: **“Uses a sample project only. Your screen, microphone, and clipboard are not used in this tour.”**

### Leaving and returning

- A persistent `Exit tour` action asks only when an in-progress demo action would be discarded.
- `Skip this step` appears on every guided step and moves to the next concept; it never marks an unperformed action as completed.
- On exit, retain the last completed step and offer `Resume tour` from the HUD help/settings entry. Do not re-open automatically after the first dismissal.
- At completion, return the HUD to the user’s prior size, position, capture state, selected agent, and privacy state. Any sample memory and demo conversation are deleted.

### Tour shell

The experience runs in a normal-looking, but clearly labeled, **Demo workspace**. It is a centered desktop-sized window with a seeded sample project behind it and the actual Sinain eye/HUD layered over the scene. A compact guide rail is attached to the lower-left edge of the HUD—not a modal that obscures the work.

Guide rail anatomy:

- step marker: `2 of 4 · Capture context`
- one imperative sentence, maximum two lines
- an animated pointer/halo that points to one control only
- `Skip`, `Exit`, and a thin progress indicator
- status that acknowledges actions: `Context ready` rather than congratulatory copy

The guide rail collapses after each successful action so the user can see the result. It expands again only for the next instruction.

## Core scenario: fix a launch-blocking checkout error

The sample project is believable but deliberately generic: a product team is preparing a launch, a terminal test is failing, and a short release note identifies the decision that will unblock it. It makes screen selection, clipboard context, agent handoff, and memory feel like one task.

Sample content (designer may revise the product name and exact prose, but should keep the information relationship):

- Terminal: `checkout-webhook.spec.ts` failing because the event signature is read from the wrong header.
- Browser/release note: “Webhook signatures move from `X-Signature` to `X-Webhook-Signature` in v3.”
- A small relevant code region: the old header name.
- Seeded answer: update the header lookup, add one regression test, and note the migration dependency.

No screen/audio capture is needed; this is static, bundled sample data. The apparent “recent context” is an explicitly labeled demo timeline.

## Timed storyboard

The timing is a target, not a countdown. A user who acts quickly should complete in about 1:45; a little time to read and inspect brings it near 2:00.

| Time | User sees | User does | Capability taught | Success state |
|---|---|---|---|---|
| 0:00–0:12 | Welcome over the sample workspace. The eye is visible; copy says: “Let’s unblock one small issue. This tour uses sample content only.” | Chooses `Start tour`. | Ambient HUD, privacy boundary | Guide rail introduces the eye as the control surface. |
| 0:12–0:27 | Terminal failure and release note are already visible. A quiet marker/eye pulse appears beside the error—not a notification. | Taps the eye, then `Context from Screen`. | Sinain notices relevant context; deliberate capture | Controls expand without stealing focus. |
| 0:27–0:44 | A one-time micro-demo shows a selection rectangle being drawn around the error and header lookup. | Draws the indicated region (or chooses `Use suggested region`). | Region capture; context is scoped by the user | Region gets a green keyline; a compact context card opens. |
| 0:44–1:02 | Context card shows: selected code, relevant release-note snippet, and a short demo timeline. Plain copy: “This is the exact context an assistant receives.” | Chooses `Ask Sinain`. | Context assembly; informed chat | Seeded response returns in stages: diagnosis, fix, regression test. No fake streaming wait. |
| 1:02–1:20 | Chat result has a `Continue with an agent` affordance. Destination sheet shows the detected/default agent, plus `Copy context seed`. | Selects the default agent, or `Copy context seed`. | Agent-agnostic handoff; user chooses destination | A compact handoff receipt says what was included: selection, release note, and conversation. |
| 1:20–1:36 | A decision row appears in the result: `Decision: migrate to X-Webhook-Signature`. It is visually separate from transient chat text. | Taps `Save to memory`; optional `Undo` appears. | Searchable memory; explicit saving | Short confirmation: `Saved to Sinain memory` with an undo window. |
| 1:36–1:52 | A small knowledge preview opens with the saved decision and related entity `Checkout webhooks`; then collapses back to HUD. | Optionally clicks `Open knowledge` or continues. | Knowledge browser and later recall | If skipped, state is still clear: “You can find this later in Knowledge.” |
| 1:52–2:00 | Privacy close: sample workspace recedes; HUD eye and a screen-share frame are shown side by side. Copy: “The HUD stays out of your screen shares. You decide what Sinain uses.” | Chooses `Finish`. | Capture controls; capture-invisible overlay | Return to normal HUD, with a single next action: `Open help anytime from Settings`. |

## Interaction details the designer should specify

### 1. Context from screen

The first action needs to make deliberate scope unmistakable. The guide should not say “Sinain captured your screen.” It should say **“Drag over the error you want help with.”**

- Show a proposed selection with a dashed outline before the user commits.
- Use a green solid outline only after selection.
- Include `Use suggested region` as an accessibility and speed fallback.
- The selected region should contain only the relevant code/error, while related release-note context appears later as a separate source. This distinction teaches that Sinain assembles context rather than treating the whole desktop as one opaque screenshot.

### 2. Context card and chat

This is the tour’s pivotal reveal. It must answer: *What will the assistant know?*

The card should show three concise, inspectable source chips:

1. `Selected region · checkout-webhook.spec.ts`
2. `Related screen context · release note`
3. `Demo timeline · 2 events`

Then show a short composed brief, not raw hidden prompts. The primary action is `Ask Sinain`; a secondary action is `Edit context`. Avoid implying that the context is automatically sent anywhere until the user taps the primary action.

### 3. Agent handoff

Handoff should look like changing the place work continues, not delegating control away.

- Use the current/default configured agent name where one exists; otherwise use `Your agent` and make `Copy context seed` primary.
- The destination sheet needs an inclusion summary and an explicit `Send`/`Continue` action.
- After success, show a receipt, not a noisy success animation: `Context sent to Codex · 3 sources included`.
- Do not actually launch a third-party terminal/editor during the tour. A simulated destination receipt is sufficient for the first-start experience; provide `Open agent` only if the installed integration supports it reliably.

### 4. Memory and knowledge

The tour should demonstrate the *decision*, not claim that everything is saved forever.

- Make the save explicit: `Save decision to memory`.
- Include a 30-second `Undo` affordance, consistent with the existing capture language.
- Preview one memory record and one relationship, then close. Do not turn the final 20 seconds into a web-app walkthrough.

### 5. Privacy close

Privacy is a reassurance and a control, not a fear-based interruption.

- Show the actual eye/HUD visual language in a split view: `Your desktop/share` versus `What viewers see`.
- State the capture-invisible behavior precisely: **“Sinain’s HUD does not appear in screen captures or screen shares.”**
- Offer links/actions for `Review privacy settings` and `Learn about local mode`; do not force a privacy-mode decision here.
- Clearly label demo mode if it is used for recording/visualization, because demo mode intentionally makes the overlay capturable.

## Information architecture and progression

```text
Invitation
  └─ Sample task
      └─ Select a region
          └─ Inspect context
              └─ Ask Sinain
                  ├─ Continue with agent / Copy seed
                  └─ Save decision
                      └─ Preview knowledge
                          └─ Privacy + finish
```

Optional capability callouts should be quiet, one-line “also available” notes—never extra required steps:

- **Save Context:** “Need the last few minutes, not one region? Save Context lets you choose the time range and apps.”
- **Clipboard context:** “Copied an error or link? Build context from Clipboard adds the surrounding situation.”
- **Audio/video capture:** “Capture controls are always available from the eye.”
- **Share:** “Knowledge can be shared as a private link without sharing the screen.”
- **Voice call:** “The same brief can start a voice call with Sinain.”

These notes can point to the existing feature tour/help after completion. They should not lengthen the guided core beyond two minutes.

## Visual direction

Use the established Sinain visual system rather than a tutorial-specific brand:

- dark graphite cards, restrained green for approved or selected actions, and the familiar eye glyph;
- sample workspace is calm and realistic—one browser/release-note pane and one terminal/editor pane, no notification collage;
- guidance is subtle: one halo, one cursor motion, one action at a time;
- prefer real product chrome and control positions; a demo-only guide rail may use a slightly softer surface so it reads as instructional rather than product state;
- transition by preserving spatial anchors: eye → controls → selected region → context card → chat. Avoid full-screen scene changes that make the HUD feel disconnected from the desktop.

### Accessibility

- Every pointer-led task has a keyboard-accessible equivalent and a `Use suggested region` fallback.
- Do not use color alone to communicate completion, privacy, or selected source.
- Respect Reduce Motion: replace cursor flights and pulsing halos with static focus rings.
- Keep body copy at normal readable desktop size; do not require users to read code to understand the task.
- Never depend on audio; captions/visible status are the source of truth.

## Copy principles

Use direct, factual verbs: **choose, select, inspect, send, save, undo**. Avoid “magic,” “always knows,” “watches everything,” or productivity promises.

Recommended microcopy:

- Invitation: `Take a 2-minute tour using a sample project.`
- First action: `Select the error you want help with.`
- Context card: `Review what will be included before you ask.`
- Handoff: `Choose where this work continues.`
- Memory: `Save this decision so it is easy to find later.`
- Privacy close: `You decide what Sinain uses.`

## What needs validation before visual production

The designer can produce the full flow now, but engineering/product should resolve these constraints during handoff:

1. **Demo data isolation:** bundled scenario, seeded answers, memory, and chat must live in a disposable demo namespace and never mix with real knowledge.
2. **Component reuse:** identify which current HUD controls can render in demo mode and which need a tour-only wrapper; preserve labels and affordances from the shipped UI.
3. **Agent availability:** define the no-agent and agent-installed variants before designing the handoff sheet.
4. **Capture privacy:** no real capture pipeline may be enabled just to make the demo look live. The UI must communicate sample data truthfully.
5. **Persistence:** store invitation-dismissed, tour-progress, and tour-completed separately, so a partial tour can resume without nagging.
6. **Analytics (optional, privacy-safe):** record local aggregate step completion only with consent; do not log sample-task text, selected coordinates, clipboard contents, screenshots, or generated responses.

## Designer deliverables

- A 16:10 primary flow (macOS desktop) covering the timed storyboard, including active, hover, selected, loading, skipped, resumed, and completed states.
- A component inventory for the demo guide rail, selection overlay, context-source chips, handoff sheet, receipt, memory confirmation, and privacy comparison.
- Two handoff variants: agent available and no compatible agent detected.
- A reduced-motion specification and keyboard focus order for every step.
- Redlines for window size/position and transition anchors relative to the eye/HUD.
- A clickable prototype with the four required actions: select region, ask, choose/copy handoff, save memory.
- A concise content spec that separates seeded sample copy from reusable tour UI copy.

## Design acceptance criteria

The proposal is ready for engineering when a first-time user can complete it without reading documentation and can accurately answer all of these afterward:

1. “How do I choose what Sinain uses as context?”
2. “Can I see what is sent before asking an AI or agent?”
3. “Can I continue the same context with my preferred agent?”
4. “What can I save and find later?”
5. “Does this demo use my real screen, audio, or clipboard?”
6. “How do I leave or revisit the tour?”

Success is not that users see every capability. Success is that they leave with a correct mental model: **Sinain helps turn chosen moments of work into portable, private context.**
