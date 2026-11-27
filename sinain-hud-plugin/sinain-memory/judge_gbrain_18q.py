#!/usr/bin/env python3
"""Score gbrain's LongMemEval 18-q hypotheses with the SAME paper-mode judge
(gpt-4o-2024-08-06) sinain uses, so the head-to-head is apples-to-apples.

Inputs:
  /tmp/lme_18q_gold.json   - [{qid,type,question,answer,n_sessions}]
  /tmp/gbrain_18q.log      - gbrain stdout; JSON lines {question_id,hypothesis,...}
Output:
  /tmp/gbrain_18q_judged.json - [{qid,type,question,gold,gbrain_answer,gbrain_label}]
"""
import json, re, sys
from eval.benchmarks.judges.longmemeval_judge import judge_paper

gold = {g["qid"]: g for g in json.load(open("/tmp/lme_18q_gold.json"))}

# parse gbrain JSON lines (only the per-question result objects have 'hypothesis')
hyps = {}
for line in open("/tmp/gbrain_18q.log"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    if "question_id" in o and "hypothesis" in o:
        hyps[o["question_id"]] = o

out = []
for qid, g in gold.items():
    h = hyps.get(qid)
    ans = (h or {}).get("hypothesis", "")
    err = (h or {}).get("error")
    if h is None:
        label = None  # gbrain produced nothing for this qid
    elif err:
        label = 0     # gbrain errored -> fail
    else:
        label = 1 if judge_paper(
            question_type=g["type"],
            question_id=qid,
            question=g["question"],
            gold=str(g["answer"]),
            response=ans,
        ) else 0
    out.append({
        "qid": qid, "type": g["type"], "question": g["question"],
        "gold": g["answer"], "gbrain_answer": ans,
        "gbrain_retrieved": (h or {}).get("retrieved_session_ids"),
        "gbrain_error": err, "gbrain_label": label,
    })
    print(f"{qid:18s} {g['type']:26s} gbrain={label}  ::  {str(ans)[:70]!r}")

json.dump(out, open("/tmp/gbrain_18q_judged.json", "w"), indent=2)
P = sum(1 for o in out if o["gbrain_label"] == 1)
N = len([o for o in out if o["gbrain_label"] is not None])
print(f"\nGBRAIN 18-q: {P}/{len(out)}  (judged {N}, {len(out)-N} missing)")
