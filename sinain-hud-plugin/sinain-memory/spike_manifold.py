#!/usr/bin/env python3
"""spike_manifold.py — mixed-curvature category manifold spike.

Tests whether an LLM-supervised INDUCTIVE map  f: MiniLM(R^384) -> Poincare(H^b)
gives (H1) better object->category membership than the hard typer, and
(H2) generalizes to HELD-OUT objects (geometry replaces the per-object LLM call).

Loads /tmp/manifold_data.json (from spike_manifold_data.py). Pure torch; CPU.
"""
import json
import random
import sys

import numpy as np
import torch
import torch.nn as nn

EPS = 1e-5
random.seed(0); torch.manual_seed(0); np.random.seed(0)


# ---------- Poincare ball ops ----------
def expmap0(v):
    n = v.norm(dim=-1, keepdim=True).clamp_min(EPS)
    return torch.tanh(n.clamp_max(15.0)) * v / n


def pdist(x, y):
    xx = (x * x).sum(-1); yy = (y * y).sum(-1); d2 = ((x - y) ** 2).sum(-1)
    den = (1 - xx).clamp_min(EPS) * (1 - yy).clamp_min(EPS)
    return torch.acosh((1 + 2 * d2 / den).clamp_min(1 + EPS))


class Map(nn.Module):
    def __init__(self, din=384, b=5, hidden=128):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(din, hidden), nn.ReLU(), nn.Linear(hidden, b))

    def forward(self, x):
        return expmap0(self.net(x) * 0.1)


def main():
    D = json.load(open("/tmp/manifold_data.json"))
    emb = {k: torch.tensor(v, dtype=torch.float32) for k, v in D["emb"].items()}
    objects = [o for o in D["objects"] if o in emb]
    cats = [c for c in D["categories"] if c in emb]
    isa = [(u, v) for u, v in D["isa"] if u in emb and v in emb]

    # H2 split: hold out 20% of OBJECTS from training is-a edges entirely
    held = set(random.sample(objects, max(1, len(objects) // 5)))
    train_isa = [(u, v) for u, v in isa if u not in held]
    print(f"vocab: {len(objects)} objs, {len(cats)} cats, {len(isa)} is-a edges "
          f"({len(train_isa)} train, held-out objs={len(held)})", file=sys.stderr)

    X = torch.stack([emb[s] for s in objects + cats])
    idx = {s: i for i, s in enumerate(objects + cats)}
    cat_idx = torch.tensor([idx[c] for c in cats])

    f = Map(b=10)
    opt = torch.optim.Adam(f.parameters(), lr=5e-3, weight_decay=1e-5)
    pos = [(idx[u], idx[v]) for u, v in train_isa]
    if not pos:
        print("FATAL: 0 is-a training edges (typing failed — check OPENROUTER key)", file=sys.stderr)
        sys.exit(1)

    for ep in range(400):
        random.shuffle(pos)
        P = f(X)                                   # all points on the ball
        Pcat = P[cat_idx]                          # category points
        u = torch.tensor([a for a, _ in pos], dtype=torch.long)
        v = torch.tensor([b for _, b in pos], dtype=torch.long)
        # negatives: 10 random categories per positive
        neg = torch.randint(0, len(cats), (len(pos), 10))
        du = pdist(P[u].unsqueeze(1), Pcat[neg])              # (n,10) to negatives
        dpos = pdist(P[u], P[v])                              # (n,) to true hypernym
        # softmax(-d): pull to true hypernym, push from negative categories
        logits = torch.cat([(-dpos).unsqueeze(1), -du], dim=1)
        loss = -(torch.log_softmax(logits, dim=1)[:, 0]).mean()
        opt.zero_grad(); loss.backward(); opt.step()
        if ep % 100 == 0:
            print(f"  ep{ep} loss={loss.item():.3f}", file=sys.stderr)

    f.eval()
    with torch.no_grad():
        P = f(X)
    Pall = {s: P[idx[s]] for s in objects + cats}

    # Calibrate the membership radius from the TRAINING positive is-a distances:
    # a test object is a member of category c if it sits within the typical
    # is-a distance of c. (Fixed THRESH was arbitrary; this is geometry-relative.)
    with torch.no_grad():
        pos_d = pdist(P[u], P[v]).numpy()
    global THRESH
    THRESH = float(np.percentile(pos_d, 80))
    print(f"\ncalibrated membership radius (80th pct of positive is-a dist) = {THRESH:.3f}",
          file=sys.stderr)

    def cat_point(name):
        from category_enrichment import _singular
        key = name if name in idx else _singular(name)
        return Pall.get(key)

    # ---------- H1: membership / count vs gold, vs hard typer ----------
    print("\n=== H1: per-question membership (manifold vs hard-typer) ===")
    obj_cats = D["obj_cats"]
    catP_all = torch.stack([Pall[c] for c in cats])
    man_hits = typ_hits = 0
    for q in D["per_q"]:
        dom = q["domain"]; gold_n = q["gold_n"]; gold_m = set(q.get("gold_members") or [])
        cobjs = [o for o in q["objects"] if o in idx]
        from category_enrichment import _singular
        dom_key = dom if dom in idx else _singular(dom)
        # manifold membership = the domain is among the object's K nearest category
        # nodes (per-object RANK, the asymmetric is-a proxy — robust to the fact
        # that general categories are far in raw hyperbolic distance).
        K = 5
        man_members = []
        if dom_key in idx:
            for o in cobjs:
                d = pdist(Pall[o].unsqueeze(0), catP_all)
                near = {cats[i] for i in torch.argsort(d)[:K].tolist()}
                if dom_key in near:
                    man_members.append(o)
        # hard typer baseline: object kept if a typer-category token-matches the domain
        from category_enrichment import _ctokens
        want = _ctokens(dom)
        typ_members = [o for o in cobjs if any(want & _ctokens(c) for c in obj_cats.get(o, []))]
        mn, tn = len(set(man_members)), len(set(typ_members))
        man_hits += (gold_n is not None and mn == gold_n)
        typ_hits += (gold_n is not None and tn == gold_n)
        prec = rec = float("nan")
        if gold_m:
            mm = set(m for m in man_members)
            inter = sum(1 for g in gold_m if any(g in m or m in g for m in mm))
            rec = inter / len(gold_m)
        print(f"[{q['qid']}] {dom!r} gold_n={gold_n} | manifold={mn} typer={tn}"
              + (f" | gold_member_recall={rec:.2f}" if gold_m else "")
              + f"\n   manifold members: {man_members[:8]}")
    print(f"\nexact-count: manifold {man_hits}/{len(D['per_q'])}  vs  hard-typer {typ_hits}/{len(D['per_q'])}")

    # ---------- H2: amortization — predict held-out objects' category by geometry ----------
    print("\n=== H2: held-out generalization (geometry vs LLM-truth) ===")
    top1 = top3 = tot = 0
    catP = torch.stack([Pall[c] for c in cats])
    for o in held:
        truth = set(obj_cats.get(o, []))
        if not truth or o not in idx:
            continue
        d = pdist(Pall[o].unsqueeze(0), catP)            # to every category
        order = [cats[i] for i in torch.argsort(d).tolist()]
        tot += 1
        top1 += order[0] in truth
        top3 += any(c in truth for c in order[:3])
    if tot:
        print(f"held-out objects: {tot} | top1={top1}/{tot} ({100*top1/tot:.0f}%) "
              f"top3={top3}/{tot} ({100*top3/tot:.0f}%)")
    print("(top-k = geometrically-nearest category appears in the LLM's labels => "
          "geometry reproduces the typer without an LLM call)")


THRESH = float(__import__("os").environ.get("MANIFOLD_THRESH", "2.5"))

if __name__ == "__main__":
    main()
