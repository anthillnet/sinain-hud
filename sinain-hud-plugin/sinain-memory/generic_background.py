"""generic_background.py — IG Feature #1: frozen generic-knowledge background for the
information-content (surprisal) salience gate.

The volatile ~70% distillation tail is INCIDENTAL world-trivia the assistant volunteered
("Bee balm repels hornworms", "Frida Kahlo underwent many surgeries", "Atmospheric
distillation is a refining process"). Such content is HIGH-probability under a generic
language model — it carries near-zero pointwise mutual information with THIS user. Stable,
salient facts are high-surprisal-relative-to-generic.

We approximate the log-likelihood-ratio  log P(f|user) − log P(f|generic)  with an embedding
kNN density estimate against (a) a FROZEN corpus of generic-knowledge sentences (this file)
and (b) the in-batch user-referencing facts. Frozen corpus + local embeddings (embed_client
has a local all-MiniLM fallback) + fixed thresholds ⇒ fully deterministic.

Anchor: Cronen-Townsend et al. clarity score (SIGIR 2002); Bayesian-surprise memory gating.
"""
from __future__ import annotations

# A fixed, domain-spanning sample of the kind of GENERIC world-knowledge / how-to /
# definitional content an assistant volunteers as background. Kept frozen so the gate is
# deterministic. ~100 sentences across cooking, gardening, science, health, history, tech,
# finance, travel, etc. — the manifold of "not-about-this-user" trivia.
GENERIC_BACKGROUND: tuple[str, ...] = (
    # cooking / food
    "Olive oil has a relatively low smoke point compared to avocado oil.",
    "Marinating meat for several hours helps tenderize it and add flavor.",
    "Baking soda can be used as a leavening agent in many recipes.",
    "Leftover cooked rice should be refrigerated within two hours to prevent bacteria.",
    "Caramelizing onions slowly over low heat brings out their natural sweetness.",
    "Turkey wraps can be refrigerated for up to three days.",
    "Roasting vegetables at high heat enhances their flavor through caramelization.",
    "Fresh herbs should be added near the end of cooking to preserve their aroma.",
    # gardening / nature
    "Bee balm repels certain garden pests while attracting pollinators.",
    "Composting kitchen scraps enriches garden soil with nutrients.",
    "Most succulents require well-draining soil and infrequent watering.",
    "Pruning fruit trees in late winter encourages healthy spring growth.",
    "Ladybugs are natural predators of aphids in the garden.",
    "Mulching helps retain soil moisture and suppress weeds.",
    # science / general knowledge
    "Photosynthesis converts sunlight, water, and carbon dioxide into glucose and oxygen.",
    "Water boils at 100 degrees Celsius at sea level.",
    "The human body is composed of roughly 60 percent water.",
    "Sound travels faster through water than through air.",
    "Atmospheric distillation is a process used to separate crude oil into fractions.",
    "Fluid catalytic cracking breaks heavy hydrocarbons into lighter, more valuable products.",
    "The speed of light in a vacuum is approximately 300,000 kilometers per second.",
    "Mitochondria are often called the powerhouse of the cell.",
    "Vaccines work by training the immune system to recognize specific pathogens.",
    "The European Medicines Agency evaluates the safety and efficacy of medicines.",
    # health / fitness
    "Regular cardiovascular exercise can improve heart health and endurance.",
    "Staying hydrated is important during prolonged physical activity.",
    "Stretching before exercise can help reduce the risk of muscle strain.",
    "A balanced diet includes proteins, carbohydrates, and healthy fats.",
    "Getting seven to nine hours of sleep supports cognitive function and recovery.",
    "Meditation can help reduce stress and improve focus.",
    # history / culture
    "Frida Kahlo was a Mexican painter known for her self-portraits.",
    "The Rosetta Stone helped scholars decipher Egyptian hieroglyphs.",
    "The Renaissance was a period of renewed interest in art and learning in Europe.",
    "Ancient Rome built an extensive network of roads across its empire.",
    "Jazz originated in the African American communities of New Orleans.",
    "The Great Wall of China was built over many centuries for defense.",
    # technology / how-to
    "Restarting a device can often resolve temporary software glitches.",
    "Two-factor authentication adds an extra layer of account security.",
    "Cloud storage allows files to be accessed from multiple devices.",
    "A solid-state drive generally offers faster read speeds than a hard disk drive.",
    "Regularly backing up data protects against accidental loss.",
    "Streaming platforms pay artists a small royalty per stream.",
    "Machine learning models improve their predictions as they are trained on more data.",
    # finance / general
    "A higher credit score generally results in better loan interest rates.",
    "Diversifying investments can help reduce overall portfolio risk.",
    "Compound interest causes savings to grow faster over time.",
    "Closing costs are fees paid at the completion of a real estate transaction.",
    "A budget helps track income and expenses over a period of time.",
    # travel / world
    "Travelers should check visa requirements before international trips.",
    "Layered clothing is useful for destinations with variable weather.",
    "Booking flights in advance can sometimes secure lower fares.",
    "Many museums offer discounted admission on certain days of the week.",
    "Jet lag can be reduced by gradually adjusting to the destination's time zone.",
    # sports / hobbies
    "Tennis string tension affects both power and control.",
    "A good warm-up routine prepares the body for athletic performance.",
    "Learning a musical instrument improves with consistent daily practice.",
    "Relative pitch can be trained by listening to and identifying intervals.",
    "Acrylic paints dry faster than oil paints.",
)

_CACHE: list[list[float]] | None = None


def _generic_vectors():
    """Embed the frozen corpus once (cached). Uses embed_client (local fallback). None if
    embeddings are entirely unavailable (gate then no-ops fail-open)."""
    global _CACHE
    if _CACHE is None:
        try:
            from embed_client import embed
            _CACHE = embed(list(GENERIC_BACKGROUND))
        except Exception:
            _CACHE = None
    return _CACHE


def _topk_mean(vec, pool, k: int = 5) -> float:
    """Mean cosine of `vec` to its top-k nearest in `pool` (vectors are unit-normalised, so
    dot = cosine). A simple kNN density estimate: high ⇒ `vec` sits in a dense region of `pool`."""
    if not pool:
        return 0.0
    sims = sorted((sum(a * b for a, b in zip(vec, p)) for p in pool), reverse=True)
    top = sims[: max(1, min(k, len(sims)))]
    return sum(top) / len(top)


def salience_scores(fact_vecs, user_vecs, k: int = 5):
    """Per-fact (LR, generic_density). LR = score_user − score_generic is the embedding
    surrogate for the surprisal log-ratio; generic_density = kNN density on the frozen generic
    manifold. Caller drops a fact when LR < θ AND generic_density ≥ g_floor (two-sided guard:
    only drop things that are genuinely generic-leaning AND not user-relevant)."""
    gen = _generic_vectors()
    if gen is None:
        return None  # no background → gate no-ops
    out = []
    for v in fact_vecs:
        sg = _topk_mean(v, gen, k)
        su = _topk_mean(v, user_vecs, k) if user_vecs else 0.0
        out.append((su - sg, sg))
    return out
