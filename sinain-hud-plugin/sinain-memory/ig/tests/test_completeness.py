"""Exact unit tests for ig.completeness. No store, no LLM, no embed service. The expected values
are the worked-case table of .planning/DESIGN-completeness-gate-answer-lattice.md, computed by the
seeded stress-test scripts — they are EXACT posteriors (closed form), not stochastic. Run:
`python3 -m ig.tests.test_completeness` from sinain-memory/."""
from ig.completeness import posterior_incomplete, gate_action

_fails = []


def check(name, cond, got=None):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"   got={got!r}"))
    if not cond:
        _fails.append(name)


def near(x, y, tol=0.005):
    return abs(x - y) <= tol


print("== worked cases (design-note table, uniform prior) ==")
# (name, channel counts, s_obs, expected P(incomplete), expected with 1/N prior)
CASES = [
    ("kits gold5: (4,3) S=5 raw caught Tiger", [4, 3], 5, 0.704, 0.603),
    ("kits gold5: (4,3) S=4 both miss Tiger", [4, 3], 4, 0.324, 0.253),
    ("kits +edges: (4,3,4) S=5", [4, 3, 4], 5, 0.222, 0.184),
    ("SHARED-BLIND-SPOT landmine: (4,4,4) S=4", [4, 4, 4], 4, 0.024, 0.019),
    ("clothing gold3: (1,3) S=3", [1, 3], 3, 0.578, 0.426),
    ("clothing +edges: (1,3,3) S=3", [1, 3, 3], 3, 0.108, 0.079),
    ("kitchen gold5 sparse: (2,3) S=4", [2, 3], 4, 0.786, 0.659),
    ("perfect agreement 2ch: (4,4) S=4", [4, 4], 4, 0.162, 0.126),
    ("aquarium-ish: (15,14) S=16", [15, 14], 16, 0.313, 0.295),
    ("zero overlap: (3,3) S=6", [3, 3], 6, 0.980, 0.947),
]
for name, ns, s, exp_u, exp_j in CASES:
    got_u = posterior_incomplete(ns, s)
    got_j = posterior_incomplete(ns, s, prior="jeffreys")
    check(f"{name} [uniform]", near(got_u, exp_u), round(got_u, 3))
    check(f"{name} [1/N]", near(got_j, exp_j), round(got_j, 3))

print("\n== gate actions (alpha=0.15, theta=0.50) ==")
GATE = [
    ("(4,4,4) S=4 → exact (correlated channels make this WRONG — caller owns diversity)",
     [4, 4, 4], 4, "exact"),
    ("(1,3,3) S=3 → exact", [1, 3, 3], 3, "exact"),
    ("(4,3) S=4 → hedged", [4, 3], 4, "hedged"),
    ("(4,4) S=4 → hedged", [4, 4], 4, "hedged"),
    ("(15,14) S=16 → hedged", [15, 14], 16, "hedged"),
    ("(4,3) S=5 → widen", [4, 3], 5, "widen"),
    ("(2,3) S=4 → widen", [2, 3], 4, "widen"),
    ("(3,3) S=6 → widen", [3, 3], 6, "widen"),
]
for name, ns, s, exp in GATE:
    got = gate_action(ns, s)
    check(name, got == exp, got)

print("\n== degenerate / fail-safe (conservative direction) ==")
check("no channels → 1.0", posterior_incomplete([], 3) == 1.0)
check("s_obs=0 → 1.0", posterior_incomplete([2, 2], 0) == 1.0)
check("union < max channel (inconsistent) → 1.0", posterior_incomplete([5, 2], 4) == 1.0)
check("union > channel total (inconsistent) → 1.0", posterior_incomplete([2, 2], 5) == 1.0)
check("negative count → 1.0", posterior_incomplete([-1, 3], 3) == 1.0)
check("single live channel → widen", gate_action([4, 0], 4) == "widen", gate_action([4, 0], 4))
check("one channel only → widen", gate_action([4], 4) == "widen", gate_action([4], 4))
check("s_obs=0 → widen", gate_action([0, 0], 0) == "widen")

print("\n== structural sanities ==")
# more channel agreement → lower P(incomplete)
check("agreement monotone",
      posterior_incomplete([4, 4], 4) < posterior_incomplete([4, 3], 4)
      < posterior_incomplete([4, 2], 4))
# a third agreeing channel tightens the posterior
check("3rd channel tightens", posterior_incomplete([4, 4, 4], 4) < posterior_incomplete([4, 4], 4))
# growing disagreement (singletons) → higher P(incomplete)
check("singletons raise P(inc)",
      posterior_incomplete([3, 3], 6) > posterior_incomplete([3, 3], 4) > posterior_incomplete([3, 3], 3))
# deterministic
check("deterministic", posterior_incomplete([4, 3], 5) == posterior_incomplete([4, 3], 5))
# tail-window insensitivity: doubling n_max_extra moves the posterior negligibly
check("tail window stable",
      near(posterior_incomplete([4, 3], 4), posterior_incomplete([4, 3], 4, n_max_extra=120), 0.01))

print()
if _fails:
    print(f"{len(_fails)} FAILED: {_fails}")
    raise SystemExit(1)
print("all passed")
