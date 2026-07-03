# Capture-Recapture Completeness Gate for Region Detection

## Problem

The region eyes system surfaces actionable screen areas, but we have no signal for
*how many we are missing*. The LLM caps at `MAX_REGIONS=3` per tick, is inherently
inconsistent across ticks, and never reports "there are 5 issues but I can only show
3." The user sees whatever eyes appear and trusts they are exhaustive — they often
are not.

A completeness gate answers: *what fraction of detectable issues is the LLM actually
catching?* Below a threshold, the system should adapt rather than quietly undercount.

## Approach — Capture-Recapture Estimation

Borrowed from ecology (estimating animal population size from two independent
trapping sessions). Here, each analysis tick is a trapping session:

| Symbol | Meaning |
|--------|---------|
| A      | Regions detected on tick T (e.g., 3) |
| B      | Regions detected on tick T+1 (e.g., 4) |
| M      | Regions detected on **both** ticks (overlap, by stable `regionId`) |
| N̂      | Estimated total detectable population |

**Lincoln-Petersen estimator** (for two sessions):

```
N̂ = (|A| × |B|) / M    when M > 0
```

**Estimated coverage** (completeness):

```
C = (|A| + |B| - M) / N̂    — or more practically: C = max(|A|, |B|) / N̂
```

The identity link is the existing `regionIdFor()` which produces a stable content-hash
from the issue text — the same re-detected issue gets the same `r-xxx` ID.

## Concrete Gate Design

### 1. Sliding window tally

Add a `CaptureRecaptureGate` class in `sinain-core/src/agent/` that maintains
a 3-entry sliding window of region-ID sets (tick N-2, N-1, N):

```typescript
class CaptureRecaptureGate {
  private window: Set<string>[] = [];   // sliding window of region id sets
  private lastEstimate: number | null = null;

  // Call every tick after RegionTracker processes its regions
  record(regionIds: Set<string>): CompletenessReport | null;
}
```

### 2. Pairwise estimation

For each pair (tick-1, tick), (tick-2, tick-1), compute N̂ using the estimator.
Average the estimates for robustness.

### 3. Gate thresholds

| Condition | Interpretation | Action |
|-----------|--------------|--------|
| `M = 0` | Zero overlap — partition change or bad issue IDs | No estimate (report null) |
| `C ≥ 0.8` | Good coverage | No action (normal operation) |
| `0.5 ≤ C < 0.8` | Moderate undercount | Surface eye with `"stale"` state hint — user sees possible undercount |
| `C < 0.5` | Severe undercount | Auto-increase `MAX_REGIONS` to 5 for next tick; warn in `hud` text |

### 4. Return type

```typescript
interface CompletenessReport {
  coverage: number;        // 0.0 - 1.0, estimated fraction detected
  estimatedTotal: number;  // N̂ (rounded to integer)
  observedTotal: number;   // union of current region ids
  overlapCount: number;    // M
  pairCount: number;       // how many (tick-1, tick) pairs contributed
}
```

## Integration Points

### `region-tracker.ts` (existing, ~203 lines)

- `RegionTracker.update()` already returns `RegionHighlight[] | null` on change.
- After the existing change-detection and expiry logic, pass the current ID set
  to the new `CaptureRecaptureGate.record()`.
- The gate's report feeds back into the tracker's expiry / max-region decision.

### `analyzer.ts` (existing)

- When `CaptureRecaptureGate` reports `C < 0.5`, inject a prompt hint on the
  *next* tick: `"You previously missed ~{X} issues. Look harder."` (but this
  risks confusing the model — see stress-test #2 below).

### `hud` message (overlay)

- When `C < 0.5`, include a subtle indicator in the HUD digest or as a
  temporary eye with action=`"research"`: "There may be more issues — rechecking."

## Stress Tests Against Known Failures

### 1. Small-sample bias (Lincoln-Petersen is biased for N̂ < 30)

**Problem**: With `MAX_REGIONS=3`, we're counting populations of ~2-6 items.
The estimator has high variance at this scale.

**Mitigation**: 
- Use the **Chapman correction** (less biased for small samples):
  ```
  N̂ = ((|A|+1)(|B|+1) / (M+1)) - 1
  ```
- Average over 3 pairs (tick-2/tick-1, tick-1/tick, tick-2/tick) instead of
  relying on a single pair.
- Do **not** trigger gate actions on a single data point — only after the
  window has 3 full entries (i.e., 3 consecutive ticks with regions detected).

### 2. LLM inconsistency in issue text → different IDs for same issue

**Problem**: `regionIdFor()` uses `sha256(normalized issue)[0:10]`. If the LLM
describes the same error differently across ticks ("missing semicolon" vs
"syntax error on line 42"), it gets different IDs — M is artificially 0.

**Mitigation**:
- Before computing M, apply **fuzzy overlap**: two IDs count as "same" when
  their issue text Levenshtein similarity > 0.75 (or bigram Jaccard > 0.6).
  This catches reformulations without collapsing distinct issues.
- `RegionTracker` already stores `tracked.get(id)!.region.issue` — the
  raw text is available for comparison.
- This is an *optimistic* overlap detector (may overcount M slightly, biasing
  N̂ downward) — safer than undercounting.

### 3. Dynamic screen content (scrolling, typing, app switches)

**Problem**: The screen changes between ticks — issues appear and disappear
organically. The estimator assumes a "closed population" (no additions or
removals between captures).

**Mitigation**:
- Only compute estimates on pairs where `ctx.currentApp` is the same (same
  application context).
- Cap the pair window to ticks within 15 seconds — beyond that, screen churn
  dominates the signal.
- When the overlap ratio `M / min(|A|, |B|)` drops below 0.3 AND the app is
  the same, the screen is changing rapidly — skip estimation and reset the
  window.

### 4. Region expiry (2 missed ticks = deletion)

**Problem**: A region detected on tick T, missed on T+1 (LLM inconsistency),
then re-detected on T+2 gets **two different IDs** because the tracker expired
it and recreated it. But both IDs derive from the same issue text — and
`regionIdFor` is deterministic, so the ID is actually the same. The expiry
only affects the tracker's internal state, not the hash stability.

**Actually this is fine.** `regionIdFor()` is text-derivative, not stateful.
The same issue text always produces the same ID even after expiry. The
*estimator* tracks its own sliding window of *ID sets*, independent of
`RegionTracker`'s TTL.

**New concern**: the estimator and the tracker have different notions of
"what's active." An expired region still counts in the estimator's window.
Mitigation: the estimator trims entries older than 4 missed ticks (2 × the
tracker's expiry), so it doesn't remember long-dead regions either.

### 5. Zero overlap (M = 0) on consecutive ticks

**Problem**: Tick 1 sees [A, B, C], tick 2 sees [D, E, F] — zero overlap.
The estimator divides by zero.

**Mitigation**:
- Detect `M = 0` and return `null` estimate (no report).
- If this happens on **3 consecutive** estimate attempts, treat it as a
  **systematic partitioning failure** (see #7 below).

### 6. MAX_REGIONS ceiling artificially flattens |A| and |B|

**Problem**: Both ticks hit the 3-region cap, but the real population is 6+.
The estimator returns a plausible-looking N̂ that is actually wrong (it assumes
both ticks saw the full population).

**Mitigation**:
- Flag estimates where `|A| = MAX_REGIONS` or `|B| = MAX_REGIONS` as
  **right-censored**.
- Censored estimates are reported but flagged: the true N̂ is *at least* the
  computed value, probably more.
- The gate should still trigger on censored estimates below threshold, but
  the action should be **increase MAX_REGIONS** (the only way to un-censor).

### 7. Systematic partitioning failure (lossy tagging)

**Problem**: The LLM partitions the screen into disjoint categories across
ticks — tick 1 catches "red errors", tick 2 catches "build warnings" — with
zero overlap every time. This indicates the prompt's `sourceId` anchoring
isn't constraining the model enough, or the model is resetting its attention.

**Mitigation**:
- After 3 consecutive null reports (M=0), emit a **diagnostic spike**: force
  the next tick to emit exactly "all regions no matter what" by temporarily
  removing `sourceId` requirement and raising `MAX_REGIONS` to 6. This is a
  one-shot probe to measure the true population.
- Log the probe result for analysis. Reset the consecutive-null counter.

### 8. Multiple populations with different detection probabilities

**Problem**: "Error" regions (red, obvious) have high detection probability;
"typographical" or "research" regions have low probability. The estimator
treats them as one population and reports average coverage, which overstates
coverage for hard-to-detect regions.

**Mitigation**:
- **Stratified estimate**: partition regions by `action` field (`fix`, `explain`,
  `research`). Compute per-action estimates and report a **weighted harmonic
  mean** across strata (lower weight for strata with <2 observations).
- The per-action coverage exposes blind spots: high fix-coverage but low
  research-coverage means the LLM is catching errors but missing conceptual
  questions.

## Implementation Sketch

### New file: `sinain-core/src/agent/capture-recapture-gate.ts`

```typescript
import { log, debug } from "../log.js";

const TAG = "capture-recapture";

const MAX_WINDOW_SIZE = 3;          // Keep 3 recent ticks
const MAX_TICK_AGE_MS = 15_000;     // Discard entries older than 15s
const OVERLAP_STRATA = ["fix", "explain", "research"] as const;

/** Bigram Jaccard similarity — catches reformulated issues */
function jaccardSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(a), bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  let intersection = 0;
  for (const x of ba) if (bb.has(x)) intersection++;
  return intersection / (ba.size + bb.size - intersection);
}

interface WindowEntry {
  tick: number;
  ts: number;
  ids: Map<string, string>;           // regionId → raw issue text (for fuzzy matching)
  actions: Map<string, string>;       // regionId → action
  currentApp: string | null;
}

interface StratumInfo {
  observed: Set<string>;
  rawIssueText: Map<string, string>;
}

export interface CompletenessReport {
  coverage: number;
  estimatedTotal: number;
  observedTotal: number;
  overlapCount: number;
  pairCount: number;
  strataCoverage: Record<string, number>;  // per-action coverage
  censored: boolean;                        // true if |A| or |B| hit MAX_REGIONS
}

export class CaptureRecaptureGate {
  private window: WindowEntry[] = [];
  private consecutiveNull = 0;

  record(
    regionIds: string[],
    issueTexts: Map<string, string>,
    actions: Map<string, string>,
    currentApp: string | null,
    tick: number,
    capsAtMax: boolean,
  ): CompletenessReport | null {
    // Prune stale entries
    const now = Date.now();
    this.window = this.window.filter(e => now - e.ts < MAX_TICK_AGE_MS);

    // Add current tick
    this.window.push({
      tick,
      ts: now,
      ids: new Map(regionIds.map(id => [id, issueTexts.get(id) ?? ""])),
      actions,
      currentApp,
    });

    // Keep window bounded
    if (this.window.length > MAX_WINDOW_SIZE) {
      this.window.shift();
    }

    // Need at least 2 entries to estimate
    if (this.window.length < 2) return null;

    // Compute pairwise estimates
    const estimates: number[] = [];
    let totalOverlap = 0;
    let totalObserved = new Set<string>();
    let pairCount = 0;
    const strataSeen: Record<string, Set<string>> = {};

    for (let i = 1; i < this.window.length; i++) {
      const a = this.window[i - 1];
      const b = this.window[i];

      // Skip cross-app pairs
      if (a.currentApp !== b.currentApp) continue;

      const setA = new Set(a.ids.keys());
      const setB = new Set(b.ids.keys());
      const allIds = new Set([...setA, ...setB]);
      allIds.forEach(id => totalObserved.add(id));

      // Fuzzy overlap: group similar-looking issue texts
      let overlapCount = 0;
      for (const idA of setA) {
        if (setB.has(idA)) {
          overlapCount++;
          continue;
        }
        const textA = a.ids.get(idA) ?? "";
        for (const idB of setB) {
          const textB = b.ids.get(idB) ?? "";
          if (jaccardSimilarity(textA, textB) > 0.6) {
            overlapCount++;
            break;
          }
        }
      }

      if (overlapCount === 0) continue;

      // Chapman-corrected estimator
      const nA = setA.size, nB = setB.size;
      const nHat = ((nA + 1) * (nB + 1)) / (overlapCount + 1) - 1;
      estimates.push(nHat);
      totalOverlap += overlapCount;
      pairCount++;

      // Track per-action strata
      for (const action of OVERLAP_STRATA) {
        if (!strataSeen[action]) strataSeen[action] = new Set();
        for (const id of setA) if (a.actions.get(id) === action) strataSeen[action].add(id);
        for (const id of setB) if (b.actions.get(id) === action) strataSeen[action].add(id);
      }
    }

    if (pairCount === 0) {
      this.consecutiveNull++;
      return null;
    }

    this.consecutiveNull = 0;

    // Average across pairs
    const nHatAvg = estimates.reduce((s, v) => s + v, 0) / estimates.length;
    const coverage = totalObserved.size > 0
      ? Math.min(totalObserved.size / nHatAvg, 1.0)
      : 0;

    // Strata coverage: for each action, what fraction of its regions were in both ticks
    const strataCoverage: Record<string, number> = {};
    for (const [action, ids] of Object.entries(strataSeen)) {
      if (ids.size < 2) {
        strataCoverage[action] = 1; // too few to estimate
        continue;
      }
      // Count how many of these ids appeared in >= 2 entries
      const freq = new Map<string, number>();
      for (const entry of this.window) {
        for (const id of entry.ids.keys()) {
          if (ids.has(id)) freq.set(id, (freq.get(id) ?? 0) + 1);
        }
      }
      const recaptured = [...freq.values()].filter(c => c >= 2).length;
      strataCoverage[action] = recaptured / ids.size;
    }

    return {
      coverage,
      estimatedTotal: Math.round(nHatAvg),
      observedTotal: totalObserved.size,
      overlapCount: totalOverlap,
      pairCount,
      strataCoverage,
      censored: capsAtMax,
    };
  }

  /** True after 3 consecutive null returns — suggests systemic partitioning failure */
  get hasSystemicFailure(): boolean {
    return this.consecutiveNull >= 3;
  }

  clear(): void {
    this.window = [];
    this.consecutiveNull = 0;
  }
}
```

### Integration into `RegionTracker`

In `region-tracker.ts`, after the existing expiry and change-detection logic
(~line 150), add:

```typescript
const report = this.completenessGate.record(
  [...this.tracked.keys()],
  new Map([...this.tracked.entries()].map(([id, t]) => [id, t.region.issue])),
  new Map([...this.tracked.entries()].map(([id, t]) => [id, t.region.action ?? "help"])),
  ctx.currentApp,
  this.tick,
  this.tracked.size >= this.maxRegions,
);
```

The report feeds into:
- `hud` message injection (via the `hud` field on the next tick) when coverage < 0.5
- Temporary `maxRegions` override when persistent low coverage is detected
- Health/log metrics for observability

## Open Questions

1. **Should the gate live in `RegionTracker` or as a `RegionTracker`-adjacent
   hook?** — Adjacent hook is cleaner (single responsibility), but the gate
   needs the region ID set and issue texts that the tracker already has, not
   the raw LLM output. A dependency-injected observer would be ideal.

2. **What does the user see?** — Options range from invisible (log-only) to
   a small HUD note ("some issues may be hidden — expanding view") to a
   visible eye with a "low coverage" indicator. The design note defaults
   to log-only for C ≥ 0.5 and HUD note for C < 0.5.

3. **False positives from rapid screen changes** — A user scrolling through
   a long file triggers a "partition change" every tick. The estimator
   correctly returns null (M ≈ 0 most pairs). But the `consecutiveNull`
   counter would hit 3 and trigger a diagnostic spike unnecessarily.
   **Fix**: reset `consecutiveNull` on app switch OR when the screen event
   count changes by > 50% between ticks (heuristic for active scrolling).

## Effort Estimate

| Step | Effort | Dependencies |
|------|--------|-------------|
| New `capture-recapture-gate.ts` | ~100 lines | None (pure logic) |
| Integrate into `RegionTracker.update()` | ~10 lines | `region-tracker.ts` |
| Gate → HUD notification plumbing | ~20 lines | `loop.ts`/`index.ts` |
| `strataCoverage` → per-action hints | ~15 lines | `analyzer.ts` |
| Diagnostic spike (systemic failure) | ~30 lines | `region-tracker.ts` + `analyzer.ts` |
| Tests for estimator + fuzzy overlap | ~80 lines | Jest/AVA setup |
| **Total** | **~255 lines** | — |

--- 

*Status: design note (pre-implementation). Formalize implementation once the
fuzzy overlap and stratum estimation are validated against real LLM output
logs from a 10-tick capture session.*