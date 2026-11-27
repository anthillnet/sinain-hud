# Memory as Geometry
### A lecture on the information-geometry features of Sinain

> 3Blue1Brown style: start from a picture, let the formula fall out of the intuition, then test it on a
> real query. Covers the IG features #1–#7, the geometric intent router, the scaffolding / reduction
> family, and — most importantly — the honest chapter on where the geometry stops.

---

## Chapter 0 — The one idea behind all of it

Let me start with a claim that sounds grandiose and then turns out to be almost mechanical:

> Every hard decision a memory system makes — *what to keep, what to merge, what's still true, what to
> fetch, how to answer* — is secretly the **same** geometry problem wearing different clothes.

Here's the picture. Every fact the system distills ("the user finished a Tamiya Spitfire kit") gets
turned into a vector — 384 numbers from a small embedding model. We normalize it to length 1. So a fact
isn't a sentence anymore; it's a **point on the surface of a sphere** in 384 dimensions. Call it the
*sphere of meaning*, S^383.

Two facts that mean the same thing sit close together. Two unrelated facts sit far apart. And "close"
has exactly one definition — the cosine of the angle between them, which for unit vectors is just the
dot product:

    sim(a, b) = cos θ = a · b = Σ_i a_i b_i

That's it. That single number — *how aligned are these two arrows* — is the only primitive. Hold onto
it, because every feature below is just a clever thing to do with dot products on a sphere. The codebase
even has the tell: `cosine` and "top-k mean cosine" appear, by my count, in seven different files.
Everyone keeps reinventing the same screwdriver. (That's why we factored it into one `ig/linalg.py`.)

Let me walk the lifecycle of a memory — write, merge, age, retrieve, answer — and show you each feature
as it comes up.

---

## Chapter 1 — Surprisal: what's even worth remembering?

**The puzzle.** A user talks all day. Most of what they say is filler — "thanks for the help," "that
makes sense." A few sentences are gold — "I'm allergic to penicillin." If you keep everything, retrieval
drowns. If you keep too little, you lose the gold. How does code, with no labels, tell signal from filler?

**The intuition.** Imagine freezing a big cloud of *generic* sentences — the boring background of human
chatter — as points on the sphere. Now a new fact arrives. Ask: *does it land inside that boring cloud,
or off on its own?* A fact in the middle of the background is, by definition, unsurprising. A fact far
from all of it is *informative* — it's telling you something the background couldn't have predicted.

That word **surprising** is the whole game, and information theory makes it precise. The information
content of an event is

    I(x) = −log p(x)

Rare event → small p → large −log p → high information. The penicillin allergy is rare in the
background; "thanks!" is not.

**The formula we use.** We approximate p(x) — the "typicality" of a fact — by its similarity to the
frozen background. For a fact vector f and a background set B:

    typicality(f) = top-k-mean_{b∈B} cos(f, b)
    surprisal(f)  = 1 − typicality(f)

and we keep the fact when surprisal clears a learned logistic gate. (Code: `generic_background.salience_scores`,
then graph-wide `_surprisal_prune_graph`.)

**Plain words:** *keep the facts that don't look like generic chatter.* Measure "generic" as closeness
to a frozen background cloud; prune the ones that blend in.

**Query example.**
- Said: *"Thanks, that's helpful! By the way I'm severely allergic to penicillin."*
- "thanks, that's helpful" → background-sim ≈ 0.71 (deep in the cloud) → pruned.
- "allergic to penicillin" → background-sim ≈ 0.18 (far out) → **kept.**
- Later query *"can I take amoxicillin?"* retrieves the surviving fact. The filler never competed.

> ⚠️ Caveat that runs through this whole lecture: surprisal-gating has a **reversion history**. Prune too
> hard and you drop a one-off fact the user asks about next week. So the gate is conservative and
> default-off until proven on a benchmark. **Geometry suggests; evidence decides.**

---

## Chapter 2 — Canonicalization: the same thought, said five ways

**The puzzle.** Over a long session the user mentions their dog three times: "I have a golden retriever,"
"my dog Max is a golden," "Max, my retriever." Three facts, one dog. Return all three and the prompt
wastes slots — and a later "how many pets?" might count the dog three times.

**The intuition.** Paraphrases of one fact form a tight **cluster** on the sphere — a clump of arrows
pointing nearly the same direction. Collapse each clump to one representative. What's the best one?

Your instinct says "the average." On a flat plane you'd average: μ = (1/n) Σ x_i. On a *sphere* the
average of unit vectors isn't on the sphere, so you renormalize — the **spherical (Karcher) mean**:

    μ = (Σ_i x_i) / ‖ Σ_i x_i ‖

But a fact is **text**, and no sentence sits at the average direction. You can't print μ. So instead of
the mean we take the **medoid** — the actual member most similar to all the others:

    medoid = argmax_i  Σ_j cos(x_i, x_j)

A real, grammatical fact that best represents the clump. The others get *soft-retracted* (marked
superseded, kept for history — reversible).

**Plain words:** *find groups of paraphrases; keep the single most central real sentence; retire the rest.*

**Query example.**
- Cluster {"I have a golden retriever", "my dog Max is a golden", "Max, my retriever"} — pairwise cos > 0.90.
- Total-similarity: 2.71, **2.78**, 2.69 → medoid = "my dog Max is a golden."
- Retrieval and counting now see **one** dog. Measured: semantic-Jaccard determinism **0.50 → 0.61** —
  the store stopped reshuffling which paraphrase won on each rebuild.

---

## Chapter 3 — Change-points: when the truth moves

**The puzzle.** January: "I live in Chicago." June: "I just moved to the suburbs." Both true *as
statements*, but only one answers "where do you live?" Naive retrieval may surface the earlier one.

**The intuition.** Line up all facts about one attribute in **time order** and look at their *values* as
points on the sphere. Usually consecutive values sit close — the truth is stable. Then at one moment the
value **jumps**: Chicago and suburbs are far apart. That jump is a *change-point*; everything after it is
the new regime.

    change at t  ⟺  cos(value_{t−1}, value_t) < δ

Detect the last such jump; keep the latest segment as current state; the earlier segment becomes history.

**Plain words:** *sort a fact's values by time, watch for a big semantic jump, trust whatever came after
the most recent jump.*

**Query example.**
- Values over time: Chicago (Jan) → Chicago (Mar) → suburbs (Jun). Jump cos(Chicago, suburbs) ≈ 0.41 < δ.
- Query *"Where does the user live now?"* → **"the suburbs."** Chicago is retained for "where in spring?"

Subtle sibling (#3b): *categorical* changes where the jump is real but the tokens aren't numbers/dates
need an extra nudge (softer embedding jump). And a hard lesson: a flag that *deletes* the old fact
(`RECURRENCE_DROP`) once erased a one-off fact the user later asked about. So we **supersede, not
delete** — the exact flag we gated **off** for the 500-question run.

---

## Chapter 4 — Entropy-weighted fusion: which witness do you trust?

**The puzzle.** Retrieval asks several "witnesses" the same question: a BM25/keyword channel, a tag
channel, an entity-graph channel. You fuse their ranked lists. But on any query one might be confident
and another guessing. Equal weight lets the guesser add noise.

**The intuition.** How do you tell a confident witness from a guessing one *without knowing the answer?*
Look at the **shape of its score distribution.** A sure witness piles weight on one or two candidates — a
sharp, *peaked* distribution. A guesser spreads scores flat. Peakedness = confidence.

Peakedness has a name: low **entropy.** Normalize a channel's scores to a distribution p and compute

    H(p) = − Σ_i p_i log p_i

Flat → H near max (log N) → don't trust. Peaked → H near 0 → trust. Fusion weight:

    w = 1 + λ · (1 − H(p)/log N)

(This is the IR *query-clarity* idea — Cronen-Townsend 2002 — applied to read-side fusion.)

**Plain words:** *trust each retrieval channel in proportion to how sharply its scores spike.*

**Query example.**
- *"What's my dentist's name?"* Entity-graph returns one sharp hit (Dr. Alvarez 0.9, rest ~0.1) → low
  entropy → upweighted. Keyword matches "name" everywhere (flat) → high entropy → downweighted.
- Fusion lands Dr. Alvarez on top; equal weights could've buried it under keyword noise.

---

## Chapter 5 — Determinantal selection: counting without double-vision

**The puzzle.** "How many model kits have I built?" Ten retrieved facts, six about the *same* B-29
bomber. A budget spent on near-duplicates means rarer kits never reach the prompt, and the count is wrong.

**The intuition (a beautiful one).** You don't want the *most relevant* ten facts; you want the most
relevant ten that are also *spread out* — covering distinct items. Picture the vectors as arrows. Six
arrows pointing the same way (B-29 mentions) span almost no area. Arrows in *different* directions span a
big chunk of space.

"Span a big chunk of space" is **volume**, and the volume spanned by a set of vectors is the
**determinant** of their Gram matrix. That's a Determinantal Point Process: the probability of a subset S
is proportional to a determinant,

    P(S) ∝ det(L_S),    L_ij = q_i · q_j · cos(x_i, x_j)

q_i = quality (relevance); the cosine term = similarity. Two near-duplicates → two nearly-parallel rows →
determinant collapses toward 0 → the DPP *refuses* to pick both. Quality **and** diversity in one
quantity. We greedily add whichever item increases log det the most (MAP-DPP).

**Plain words:** *fill the fact budget with items pointing in different directions — distinct instances —
not six copies of one. Maximize the volume they span.*

**Query example.**
- Candidates: B-29 ×6, Spitfire ×1, Camaro ×1, F-15 ×1, "weathering tips" ×1.
- Equal top-k → prompt is 6 B-29s → model sees one kit, says "a few."
- DPP → one B-29 + Spitfire + Camaro + F-15 → four directions, four kits visible.

> Honesty: this *still* wasn't enough to make counting work. Diversity fixes double-vision but can't
> conjure a kit retrieval never fetched, nor decide which facts are *kits* vs *tips about kits*. See
> Chapter 9.

---

## Chapter 6 — Recurrence: what matters is what returns

**The puzzle.** Importance without labels. Among a thousand facts, which are central to who the user
*is*, versus one-off noise? You have no "importance" annotations.

**The intuition.** Watch the *stream* over time. A theme that matters keeps **coming back** — the startup
on Monday, again Thursday, again next week. Noise appears once. This is a **self-exciting (Hawkes)
process**: recurring events reinforce themselves.

Define importance by forward recurrence:

    importance(f) = Σ_{g after f} 1[ cos(f, g) > τ ]

Count later facts within angle τ of this one. High = a returning theme = important. Zero = a one-off.

**Plain words:** *a fact's importance is how often the same idea shows up again later. Real themes echo;
noise doesn't.*

**Query example.** On a deliberately noisy grab-bag transcript (real themes + fictional D&D chatter),
top-recurrence facts were exactly the user's genuine concerns; recur-zero facts were precisely the
fiction. No labels, no LLM — the geometry of repetition sorted them.

---

## Chapter 7 — Reading the question's shape (geometric intent)

Before we *answer* cleverly, we must know what *kind* of question we face. Also geometry.

**The puzzle.** "How many days passed between the two visits?" and "How many restaurants have I tried?"
both start "how many," but one wants *date subtraction* and the other a *count*. Keywords can't separate
them — they share the trigger words.

**The intuition.** Freeze a handful of *example* phrasings per intent — a constellation of "duration"
questions, another of "counting" questions. A new question is a point; classify it by **which
constellation it's nearer to.** Judge nearness *relatively* (the clouds overlap, so an absolute threshold
fails):

    is_duration(q) ⟺  mean-cos(q, M_dur) − mean-cos(q, M_cnt) > margin
                       AND mean-cos(q, M_dur) > floor

where mean-cos(q, M) is the top-k mean cosine to manifold M's exemplars.

**Plain words:** *decide a question's type by which set of example questions it most resembles — and when
two types are close, go with whichever it's relatively nearer to.*

**Query example.**
- "How many weeks ago did I meet my aunt?" → duration 0.52 > counting 0.34 → **duration.** ✓
- "How many camping trips did I take?" → counting > duration → **counting.** ✓
- A regex on "how many" would've sent both the same place.

This frozen-exemplar-manifold trick is the reusable engine — duration detection, preference detection,
and (intended) the scaffolds below.

---

## Chapter 8 — Scaffolding: the sufficient statistic

The centerpiece. Everything so far *managed* memory. This *answers* from it — and it's where geometry
meets a sharp, humbling reality.

**The puzzle.** Ask an LLM "how many days between March 3rd and March 9th?" with the dates buried in ten
facts, and it cheerfully hallucinates "11." LLMs are *bad at the mechanical step* — counting,
subtracting, summing — and *good at reading a fact and phrasing it.* Split the labor.

**The deep idea — sufficiency.** A **sufficient statistic** T(F) captures everything you need about a
quantity θ — the data factorizes as

    p(F | θ) = h(F) · g( T(F), θ )

so once you know T(F), the raw data F tells you nothing more about θ. *T throws away the noise and keeps
exactly the signal the answer needs.* For a structured question, the answer **is** a sufficient statistic
of the retrieved facts:

    DURATION  "how long between…"  → T = max(dates) − min(dates)
    COUNT     "how many…"          → T = | dedup(F) |
    SUM       "how much total…"    → T = Σ_i v_i
    ARGMAX    "which is the most…" → T = argmax_i key_i

The **scaffold** computes T(F) in *code* — deterministically, no hallucination — and prepends it to the
prompt as a head fact ("Dated timeline … use these EXACT dates"). The LLM's job collapses from
*retrieve → reason → compute → phrase* to just *phrase.* Neuro-symbolic split: **symbolic computes the
statistic, neural verbalizes it.**

**Plain words:** *do the arithmetic the model is bad at in code, hand it the finished number, let it write
the sentence.*

**The reduction family.** The table above is one idea five times: *retrieve typed values → apply a
reduction → present.* Count is |·|, duration is "subtract the extremes," sum is Σ, superlative is argmax.
One engine (`ig/reduction.py`), only the **operator** swaps. On the full benchmark these five shapes are
**~57% of all questions** — the reduction family *is* the bulk of memory QA.

**Query example that works (DURATION):**
- Facts: "met March 3rd," "left March 9th."
- Scaffold computes T = 9 − 3 = 6, prepends "…elapsed = 6 days."
- Model answers **"6 days."** Without the scaffold it computed 11 from mis-read dates.

---

## Chapter 9 — The honest chapter: where the geometry stops

The most important thing I can teach you, because we learned it by being wrong.

We were *sure* the COUNT and SUM scaffolds would work — the sufficiency story is airtight. We ran a
controlled same-store A/B and they flipped **zero** questions. The autopsy generalizes:

**1. The arithmetic was never the bottleneck — *selection* was.** To sum "bike expenses," code must first
decide *which* dollar amounts are bike expenses. It summed a $40 light + a $25 chain + a **$50 gift** —
nothing told it the gift wasn't a bike expense. `parse_number` extracts cleanly; it extracts from the
*wrong facts.* "Which facts are instances of the category" is a *semantic* judgment, and code has no more
of it than the LLM. Counting and summing are **selection-bound**; the scaffold adds zero selection power.

**2. Why duration is the exception.** Duration works because its selection is **structural, not
semantic**: "the facts with dates," read off the `occurred_at` field — no "is this a bike expense?"
judgment. So the real principle isn't "code beats the LLM at arithmetic." It's:

> **Scaffolding wins only when operand selection is *structural*; it loses when selection is *semantic*.**

Dates you select by field. Bike-expenses-versus-gifts you cannot.

**3. Underneath even that — recall.** On the bike question the gold was $185 = $120 + $40 + $25, and the
**$120 helmet price was deleted by the distiller**, surviving only in the raw transcript. No read-side
cleverness can sum a number that isn't in the store.

But this failure handed us the one thing that *did* work — a retrieval idea, not a scaffold:

**Query-altitude reformulation.** "Total spent on bike **expenses**" is phrased at the *aggregate*
altitude. The evidence — "I bought my helmet for **$120**" — lives at the *purchase-event* altitude. A
single semantic query for "expenses" doesn't point at sentences about buying a helmet. So: detect the
spending question, **strip the aggregate words** (expenses, cost, money), keep the domain noun (*bike*),
**add purchase-event vocabulary** (cost, price, paid, bought), fire that as a second query, and *lead*
with those chunks so they survive the prompt's excerpt cap.

    q_literal  ──(drop aggregate words, add event words)──▶  q_cost-intent

In-context recall of the three gold purchases went **0/3 → 3/3.** It didn't flip *that* question (the
$120 was destroyed upstream, and the QA prompt trusts the lossy fact over the raw transcript) — but the
*retrieval* lever is real and general.

**The closing principle.** Every "answer X" failure climbs a ladder:

    compute  →  retrieve-wide  →  reformulate-the-query  →  synthesize

and exactly one rung is binding. The whole art is **finding which rung** before you build.

---

*The throughline in one sentence: meaning is geometry, so remembering is geometry — but answering is
geometry only until you hit recall, selection, and the prompt, and those you have to respect, not rotate.*
