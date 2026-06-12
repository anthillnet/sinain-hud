"""ig.completeness — capture–recapture completeness posterior for reduction member-sets.

Answers, at question time and WITHOUT ground truth: "is the member set I assembled for this
count/list question complete?" — as a posterior over the true set size N given how many members
each independent evidence channel captured.

Model (marginal-p Bayes, "R6" in the design note): members are exchangeable; channel c captures
each member independently with unknown probability p_c ~ Uniform(0,1), marginalized out:

    P(data | N)  ∝  N!/(N − S_obs)!  ·  ∏_c B(n_c + 1, N − n_c + 1)

where n_c = members captured by channel c and S_obs = |union|. Closed form, any channel count,
log-space stable. Unlike the textbook hypergeometric-conditional gate it USES the evidence in
channel agreement (perfect agreement ⇒ high inferred p_c ⇒ tighter posterior).

⚠ STRESS-TESTED LIMITS (see .planning/DESIGN-completeness-gate-answer-lattice.md §Stress-test —
read it before trusting this number):
- This is a one-sided INCOMPLETENESS detector / escalation router, NOT a completeness certifier.
  At N∈[3,5] with 2 channels the posterior cannot concentrate (false-abstain ≈ 99% at α=0.15).
- The posterior is only as honest as the channels are failure-DECORRELATED. Channels that share a
  blind spot (e.g. typed edges derived from the same distiller output) make it confidently wrong
  (worked case: ns=(4,4,4), S=4 → P(inc)=0.024 on a gold-5 set). The CALLER owns channel diversity.
- Blind to precision errors (junk members): run AFTER canonical dedup + membership filtering.

ig invariants: pure stdlib, no IO/store/embed coupling, deterministic, fail-safe — inconsistent
input returns the conservative answer (P(incomplete)=1.0 / "widen") rather than raising.
"""
from __future__ import annotations

import math

__all__ = ["posterior_incomplete", "gate_action"]


def posterior_incomplete(ns: list[int], s_obs: int, *, prior: str = "uniform",
                         n_max_extra: int = 60) -> float:
    """P(N > s_obs | data): posterior probability that the true member set is LARGER than the
    observed union — i.e. that the assembled set is incomplete.

    ns:     per-channel captured-member counts (after canonicalization + membership filter).
    s_obs:  size of the union of all channels' member sets.
    prior:  "uniform" over N ∈ [max(s_obs, max ns), s_obs + n_max_extra], or "jeffreys" (∝ 1/N,
            mildly favors smaller N).

    Degenerate/inconsistent input (no channels, s_obs == 0, s_obs < max(ns), s_obs > sum(ns))
    returns 1.0 — "assume incomplete", the conservative routing direction.
    """
    if not ns or s_obs <= 0:
        return 1.0
    if any((not isinstance(n, int)) or n < 0 for n in ns):
        return 1.0
    if s_obs < max(ns) or s_obs > sum(ns):
        return 1.0  # union can't be smaller than a channel nor larger than the channel total
    lo = max([s_obs] + list(ns))
    hi = s_obs + max(1, n_max_extra)
    log_post = []
    for n_true in range(lo, hi + 1):
        lp = math.lgamma(n_true + 1) - math.lgamma(n_true - s_obs + 1)
        for n_c in ns:
            # log B(n_c+1, N−n_c+1)
            lp += (math.lgamma(n_c + 1) + math.lgamma(n_true - n_c + 1)
                   - math.lgamma(n_true + 2))
        if prior == "jeffreys":
            lp -= math.log(n_true)
        log_post.append(lp)
    mx = max(log_post)
    weights = [math.exp(l - mx) for l in log_post]
    z = sum(weights)
    if z <= 0.0:
        return 1.0
    tail = sum(w for n_true, w in zip(range(lo, hi + 1), weights) if n_true > s_obs)
    return tail / z


def gate_action(ns: list[int], s_obs: int, *, alpha: float = 0.15, theta: float = 0.50,
                prior: str = "uniform") -> str:
    """Three-way routing decision for a reduction member-set (NEVER a binary certify):

        "exact"   P(incomplete) ≤ alpha  — set may be presented as exhaustive ("N is K: …").
                  Only meaningful when the channels are failure-decorrelated AND ≥ 2 channels
                  captured members; correlated channels make this confidently wrong (see module
                  docstring). Expected to be RARE at small N — that is correct behavior.
        "hedged"  alpha < P ≤ theta      — present the set as known-but-possibly-incomplete
                  ("K that I know of: …"), always WITH the member list.
        "widen"   P > theta              — escalate one lattice level (wider retrieval /
                  session sweep); at the widest level, answer hedged with the best set.

    Fewer than 2 channels with captures → "widen" (a single channel can never certify).
    """
    if sum(1 for n in ns if n > 0) < 2 or s_obs <= 0:
        return "widen"
    p_inc = posterior_incomplete(ns, s_obs, prior=prior)
    if p_inc <= alpha:
        return "exact"
    if p_inc <= theta:
        return "hedged"
    return "widen"
