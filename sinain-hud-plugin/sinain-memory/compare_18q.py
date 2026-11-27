#!/usr/bin/env python3
"""Build the 1-by-1 sinain-memory vs gbrain comparison on the LongMemEval 18-q set.
Both use the SAME reader (google/gemini-2.5-flash) and SAME judge (gpt-4o-2024-08-06),
so the only variable is the memory/retrieval substrate.

Reads:
  /tmp/lme_18q_gold.json
  /tmp/gbrain_18q_judged.json
  eval/benchmarks/results/lme-18q-compare/longmemeval_results.json (sinain)
Writes:
  /tmp/compare_18q.md
"""
import json, os, sys

gold = {g["qid"]: g for g in json.load(open("/tmp/lme_18q_gold.json"))}
gb = {o["qid"]: o for o in json.load(open("/tmp/gbrain_18q_judged.json"))}

SIN_RESULTS = "eval/benchmarks/results/lme-18q-compare/longmemeval_results.json"
SIN_PROG = "eval/benchmarks/results/lme-18q-compare/longmemeval_progress.jsonl"

sin = {}
sin_ans = {}
if os.path.exists(SIN_RESULTS):
    d = json.load(open(SIN_RESULTS))
    for r in d.get("details", []):
        a = r["answers"]["sinain-memory"]
        sin[r["id"]] = int(a.get("paper_label") or 0)
        sin_ans[r["id"]] = (a.get("text") or "")[:90]
elif os.path.exists(SIN_PROG):
    for l in open(SIN_PROG):
        try: r = json.loads(l)
        except: continue
        a = r.get("answers", {}).get("sinain-memory", {})
        sin[r["id"]] = int(a.get("paper_label") or 0)
        sin_ans[r["id"]] = (a.get("text") or "")[:90]
else:
    print("WARNING: no sinain results yet", file=sys.stderr)

rows = []
for qid, g in gold.items():
    s = sin.get(qid)
    b = gb[qid]["gbrain_label"]
    rows.append((qid, g["type"], g["answer"], s, b, sin_ans.get(qid, ""), gb[qid]["gbrain_answer"][:90]))

S = sum(1 for r in rows if r[3] == 1)
B = sum(1 for r in rows if r[4] == 1)
Sn = len([r for r in rows if r[3] is not None])

def m(x): return {1: "✓", 0: "✗", None: "—"}[x]

lines = []
lines.append(f"# LongMemEval 18-q — sinain-memory vs gbrain (1-by-1)\n")
lines.append(f"Same reader (gemini-2.5-flash) · same judge (gpt-4o-2024-08-06) · only the memory substrate differs.\n")
lines.append(f"**sinain: {S}/{Sn}  ·  gbrain: {B}/18**\n")
lines.append("| qid | type | gold | sinain | gbrain |")
lines.append("|-----|------|------|:------:|:------:|")
# group by category
order = ["single-session-user","single-session-assistant","single-session-preference",
         "knowledge-update","temporal-reasoning","multi-session"]
for cat in order:
    for r in [x for x in rows if x[1] == cat]:
        qid, typ, goldv, s, b, sa, ba = r
        lines.append(f"| {qid} | {typ} | {str(goldv)[:28]} | {m(s)} | {m(b)} |")

# disagreement summary
sin_only = [r[0] for r in rows if r[3] == 1 and r[4] == 0]
gb_only  = [r[0] for r in rows if r[4] == 1 and (r[3] == 0)]
both_pass = [r[0] for r in rows if r[3] == 1 and r[4] == 1]
both_fail = [r[0] for r in rows if (r[3] == 0) and r[4] == 0]
lines.append("\n## Where they differ")
lines.append(f"- **Both pass ({len(both_pass)}):** {', '.join(both_pass) or '—'}")
lines.append(f"- **sinain only ({len(sin_only)}):** {', '.join(sin_only) or '—'}")
lines.append(f"- **gbrain only ({len(gb_only)}):** {', '.join(gb_only) or '—'}")
lines.append(f"- **Both fail ({len(both_fail)}):** {', '.join(both_fail) or '—'}")

out = "\n".join(lines)
open("/tmp/compare_18q.md", "w").write(out)
print(out)
