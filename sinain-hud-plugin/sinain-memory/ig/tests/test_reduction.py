"""Synthetic-vector / synthetic-fact unit tests for ig.reduction. No store, no LLM, no embed service
— the pattern that validated _count_scaffold. Run: `python3 -m ig.tests.test_reduction` from
sinain-memory/. Examples are grounded in real LongMemEval questions (the 500-q survey)."""
import numpy as np

from ig.reduction import (
    parse_number, parse_iso_date, detect_op, reduction_scaffold,
    reduce_count, reduce_sum, reduce_mean, reduce_argmax, reduce_recency, reduce_span_days,
)

_fails = []
def check(name, cond, got=None):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"   got={got!r}"))
    if not cond:
        _fails.append(name)

def fact(value, eid=None, occurred_at=None, **kw):
    d = {"value": value, "kind": "fact"}
    if eid: d["entity_id"] = eid
    if occurred_at: d["occurred_at"] = occurred_at
    d.update(kw); return d


print("== parse_number ==")
check("$185", parse_number("the user spent $185 total") == (185.0, "$"), parse_number("$185"))
check("2 hours", parse_number("averaging 2 hours per day") == (2.0, "hours"), parse_number("2 hours"))
check("16GB", parse_number("upgraded to 16GB of RAM") == (16.0, "gb"), parse_number("16GB"))
check("$0.75", parse_number("earned $0.75 cashback") == (0.75, "$"), parse_number("$0.75"))
check("1,250", parse_number("drove 1,250 miles")[0] == 1250.0, parse_number("1,250 miles"))
check("no-number", parse_number("the user likes jazz") is None)
check("iso-date", parse_iso_date("met on 2026-03-14 downtown") == "2026-03-14")
check("bad-date", parse_iso_date("2026-13-40") is None)

print("\n== detect_op (real LME question stems) ==")
cases = {
    "How much total money have I spent on bike-related expenses since the start of the year?": "sum",
    "How much screen time have I been averaging on Instagram per day?": "mean",
    "Which grocery store did I spend the most money at in the past month?": "argmax_max",
    "Which mode of transport did I use most recently, a bus or a train?": "recency_latest",
    "Which event did I participate in first, the charity gala or the charity bake sale?": "recency_earliest",
    "How many days passed between the two visits?": "span_days",
    "How many model kits have I worked on or bought?": "count",
    "What is the user's favorite color?": None,
}
for q, want in cases.items():
    got = detect_op(q)
    check(f"route: {q[:45]}", got == want, got)

print("\n== reduce_sum / mean (bike $185; avg) ==")
bike = [fact("spent $45 on bike tires"), fact("spent $90 on a new helmet"), fact("spent $50 on gloves")]
r = reduce_sum(bike); check("sum bike = $185", r and r.value == "$185", r and r.value)
avg = [fact("2 hours screen time Monday"), fact("3 hours Tuesday"), fact("1 hours Wednesday")]
r = reduce_mean(avg); check("mean = 2 hours", r and r.value == "2 hours", r and r.value)
mixed = [fact("spent $45"), fact("drove 90 miles")]  # mixed units, each singleton
check("mixed units -> None", reduce_sum(mixed) is None)

print("\n== reduce_argmax (which store spent most) ==")
stores = [fact("spent $120 at Thrive Market"), fact("spent $80 at SaveMart"), fact("spent $40 at Aldi")]
r = reduce_argmax(stores, "max"); check("argmax = Thrive $120", r and "Thrive" in r.value, r and r.value)
r = reduce_argmax(stores, "min"); check("argmin = Aldi $40", r and "Aldi" in r.value, r and r.value)
check("argmax singleton -> None", reduce_argmax([fact("$5 here")], "max") is None)

print("\n== reduce_recency / span_days (dated) ==")
ev = [fact("took the bus", occurred_at="2026-02-01"), fact("took the train", occurred_at="2026-05-20"),
      fact("rode a bike", occurred_at="2026-03-10")]
r = reduce_recency(ev, "latest"); check("latest = train", r and "train" in r.value, r and r.value)
r = reduce_recency(ev, "earliest"); check("earliest = bus", r and "bus" in r.value, r and r.value)
visits = [fact("first visit", occurred_at="2026-01-01"), fact("second visit", occurred_at="2026-01-07")]
r = reduce_span_days(visits); check("span = 6 days", r and r.value.startswith("6 days"), r and r.value)

print("\n== reduce_count (5 distinct + 2 dup) ==")
def unit(v): v = np.asarray(v, float); return v / (np.linalg.norm(v) + 1e-9)
base = [unit(np.eye(8)[i]) for i in range(5)]
vecs = [base[0], base[1], base[2], unit(base[0] + 0.05 * np.eye(8)[6]), base[3], unit(base[2] + 0.05 * np.eye(8)[7]), base[4]]
kits = [fact(f"kit {i}", eid=f"f{i}") for i in range(7)]
embs = {f"f{i}": vecs[i] for i in range(7)}
r = reduce_count(kits, embs); check("count = 5", r and r.value == "5", r and r.value)
check("count no-embs -> None", reduce_count(kits, None) is None)

print("\n== public reduction_scaffold end-to-end ==")
sc = reduction_scaffold("How much total did I spend on bikes?", bike)
check("sum scaffold text", sc and "= $185" in sc["value"] and sc["op"] == "sum", sc and sc.get("value"))
sc = reduction_scaffold("What is my favorite color?", bike)
check("no-op -> None", sc is None)
sc = reduction_scaffold("How many kits?", kits, embs)
check("count scaffold", sc and "deduplicated total is 5" in sc["value"], sc and sc.get("value"))

print("\n" + ("ALL PASS" if not _fails else f"FAILURES: {_fails}"))
raise SystemExit(1 if _fails else 0)
