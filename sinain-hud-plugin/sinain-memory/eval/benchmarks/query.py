"""Query pipeline — benchmark questions → LLM answers under 3 conditions.

Condition A (sinain-memory): answer from knowledge graph facts
Condition B (full-context):  answer from full conversation history
Condition C (knowledge-doc): answer from portable knowledge document
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Add sinain-memory to path
_koog_dir = str(Path(__file__).resolve().parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from common import call_llm  # noqa: E402

from .base_adapter import BenchmarkQuestion
from .config import QA_MODEL, MAX_FACTS_PER_QUERY


def _extract_keywords(query: str) -> list[str]:
    """Extract search keywords (reuses logic from retrieval_evaluator)."""
    import re
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query.lower())
    stopwords = {
        "the", "is", "in", "on", "for", "and", "or", "of", "to", "a", "an",
        "it", "was", "not", "how", "what", "when", "does", "did", "do", "my",
        "your", "their", "have", "has", "had", "are", "were", "been", "being",
        "about", "from", "with", "that", "this", "which", "who", "whom",
        "where", "why", "can", "could", "would", "should",
    }
    return [w for w in words if len(w) > 2 and w not in stopwords]


def _get_all_facts_text(db_path: str) -> str:
    """Dump ALL facts from the knowledge graph as formatted text.

    Sinain triplestores are small (10-50 facts per session), so including
    everything is feasible and avoids tag-matching failures.
    """
    from graph_query import query_top_facts, format_facts_text

    facts = query_top_facts(db_path, limit=50)
    if not facts:
        return "(no knowledge available)"
    return format_facts_text(facts, max_chars=6000)


def _resolve_profile_kwargs(profile: str | None) -> dict:
    """Translate a profile name into query_facts_hybrid kwargs. None = no overrides."""
    if not profile:
        return {}
    try:
        from query_params import resolve_profile
        return resolve_profile(profile)
    except Exception:
        return {}


def _query_knowledge(
    db_path: str,
    question: str,
    profile: str | None = None,
    gold_keywords: list[str] | None = None,
    speaker_filter: list[str] | None = None,
) -> str:
    """Query sinain knowledge graph for benchmark evaluation.

    Uses the same retrieval pipeline (query_facts_hybrid + format) as the
    live system, but queries the per-question benchmark store directly.
    This ensures evaluation measures the actual KG quality, not whether
    sinain-core happens to be running or which DB it's pointing at.

    profile: optional named caller profile (eval/escalation/agent-tick/etc).
        When set, the profile's precision_mode / hop_depth / format / etc are
        applied. Default behavior preserved when None.

    gold_keywords: optional oracle-mode keyword list for SINAIN_ABLATE=retrieval
        (mode=oracle). Plan 05's runner wires this; in Plan 04 it stays None
        at the call site so oracle reduces to passthrough until then.
    """
    from graph_query import query_facts_hybrid, format_facts_compact

    ablate = os.environ.get("SINAIN_ABLATE", "none")
    if ablate == "retrieval":
        from eval.benchmarks.ablation.retrieval_stub import stub_retrieve
        ablate_mode = os.environ.get("SINAIN_ABLATE_MODE", "passthrough")
        facts = stub_retrieve(
            db_path,
            question,
            max_facts=MAX_FACTS_PER_QUERY,
            mode=ablate_mode,
            gold_keywords=gold_keywords,
        )
    else:
        kwargs = _resolve_profile_kwargs(profile)
        if speaker_filter:
            kwargs["mentioned_by_speaker"] = list(speaker_filter)
        facts = query_facts_hybrid(db_path, question, max_facts=MAX_FACTS_PER_QUERY, **kwargs)
    if not facts:
        return "(no facts retrieved)"

    # Profiles may return non-list shapes (narrative). Coerce to text in that case.
    if not isinstance(facts, list):
        return str(facts)[:1200]
    # Temporal binding is applied in graph_query.query_facts_hybrid (the shared
    # PRODUCTION path) — it embeds the session date into the fact value for
    # date-math queries, so it's already in `facts` here. No bench-only logic.
    # 2000 (was 1200): with MAX_FACTS_PER_QUERY=20, widen the fact budget so the
    # additional gold-bearing facts at rank 11-20 actually reach the prompt rather
    # than being truncated. Excerpts keep their own separate budget downstream.
    return format_facts_compact(facts, max_chars=2000)


def _get_retrieved_facts(
    db_path: str, question: str, k: int = 10, profile: str | None = None,
    speaker_filter: list[str] | None = None,
) -> list[dict]:
    """Get facts retrieved for a question (for retrieval evaluation)."""
    from graph_query import query_facts_hybrid, query_top_facts

    kwargs = _resolve_profile_kwargs(profile)
    if speaker_filter:
        kwargs["mentioned_by_speaker"] = list(speaker_filter)
    facts = query_facts_hybrid(db_path, question, max_facts=k, **kwargs)
    if facts and isinstance(facts, list):
        return facts

    # Fallback: top facts by confidence. Lever 4 invariant — when a speaker
    # filter is in effect we must NOT bypass it via the unfiltered top-facts
    # path (legacy graphs without mentioned_by triples would otherwise leak
    # back through and produce misleading recall metrics that contradict the
    # actual answer-gen path which DOES respect the filter).
    if speaker_filter:
        return []
    return query_top_facts(db_path, limit=k)


def compute_content_recall(
    retrieved_facts: list[dict],
    gold_answer: str,
    k_values: list[int] | None = None,
) -> dict:
    """Content-based retrieval metric: do retrieved facts contain the answer?

    Instead of matching entity IDs (which don't align between LongMemEval
    session IDs and sinain entity IDs), we check whether the gold answer's
    key terms appear in any retrieved fact's content.
    """
    from .config import K_VALUES
    ks = k_values or K_VALUES

    gold_terms = set(_extract_keywords(str(gold_answer)))
    if not gold_terms:
        return {f"content_recall@{k}": 0.0 for k in ks}

    result = {}
    for k in ks:
        top_k = retrieved_facts[:k]
        # Check if any fact in top-k contains gold answer terms
        for fact in top_k:
            fact_text = f"{fact.get('entity', '')} {fact.get('value', '')}".lower()
            fact_terms = set(_extract_keywords(fact_text))
            overlap = gold_terms & fact_terms
            if len(overlap) >= max(1, len(gold_terms) // 2):  # ≥50% of gold terms
                result[f"content_recall@{k}"] = 1.0
                break
        else:
            result[f"content_recall@{k}"] = 0.0

    return result


def answer_question(
    question: BenchmarkQuestion,
    condition: str,
    *,
    db_path: str | None = None,
    full_context: str | None = None,
    knowledge_doc: str | None = None,
    model: str | None = None,
    profile: str | None = None,
) -> str:
    """Generate an answer for a benchmark question under a specific condition.

    Returns the LLM's answer text.

    profile: optional caller profile applied to sinain-memory retrieval (only
        affects the "sinain-memory" condition; full-context and knowledge-doc
        are unaffected by retrieval params by design).
    """
    qa_model = model or QA_MODEL

    if condition == "sinain-memory":
        assert db_path, "db_path required for sinain-memory condition"
        # Lever 4: per-question speaker filter from QA metadata.
        speaker_filter = (question.metadata or {}).get("speaker_filter") or None
        facts = _query_knowledge(db_path, question.text, profile=profile, speaker_filter=speaker_filter)
        system = (
            "Answer the question using the knowledge facts and transcript "
            "excerpts below. The knowledge facts are your curated memory: "
            "deduplicated and kept up to date to the latest known state — treat "
            "them as the primary source, especially for questions about "
            "someone's current situation or what changed. Transcript excerpts "
            "are verbatim raw source: use them to recover specific details the "
            "facts omit, or when a fact is framed as a goal/plan rather than a "
            "completed outcome. If an excerpt and a fact disagree about the "
            "current state, trust the fact — it reflects the most recent update, "
            "while excerpts may quote a superseded earlier state. Synthesize "
            "across items and make reasonable inferences they support. Be "
            "concise and specific. Only say \"I don't know\" if the answer is "
            "genuinely absent from BOTH the facts and the excerpts."
        )
        # Temporal "now" anchor: elapsed-time / "X ago" / ordering questions need
        # a reference date. In the bench that's question_date (when the user asks);
        # in production it's the wall clock — identical role, so production-faithful.
        # The facts already carry their event date ("[YYYY-MM-DD] ...") via
        # graph_query's temporal binding when the query shows date intent.
        import re as _re_t
        _qmeta = question.metadata or {}
        _qdate = (_qmeta.get("question_date") or "").split(" ")[0].replace("/", "-")
        _temporal = bool(_re_t.search(
            r"how many (days|weeks|months|years)|(days?|weeks?|months?|years?) ago"
            r"|how long|days? (between|since|until)|order (from|of)|first to last"
            r"|which .*(first|last|before|after|earliest|latest)|when did",
            question.text.lower(),
        ))
        _now_line = f"Today's date is {_qdate}.\n\n" if (_temporal and _qdate) else ""
        user = f"{_now_line}## Knowledge Facts\n{facts}\n\n## Question\n{question.text}"

    elif condition == "full-context":
        assert full_context, "full_context required for full-context condition"
        system = (
            "Answer the question based on the conversation history below. "
            "Be concise and specific."
        )
        # Truncate context if too large (some models have limits)
        ctx = full_context[:100_000] if len(full_context) > 100_000 else full_context
        user = f"## Conversation History\n{ctx}\n\n## Question\n{question.text}"

    elif condition == "knowledge-doc":
        assert knowledge_doc, "knowledge_doc required for knowledge-doc condition"
        system = (
            "Answer the question using ONLY the knowledge document provided. "
            "If the document doesn't contain enough information, say \"I don't know.\""
        )
        user = f"## Knowledge Document\n{knowledge_doc}\n\n## Question\n{question.text}"

    else:
        raise ValueError(f"Unknown condition: {condition}")

    try:
        # temperature=0 + fixed seed — eval reproducibility. Same retrieved facts
        # MUST produce the same answer, or run-to-run paper_label deltas are noise
        # (observed 2026-05-29: gemini flipped q1 1↔0 on identical input at temp=0
        # with no seed). Seed override: SINAIN_QA_SEED.
        import os as _os
        qa_seed = int(_os.environ.get("SINAIN_QA_SEED", "42"))
        return call_llm(
            system_prompt=system,
            user_prompt=user,
            model=qa_model,
            # 2026-05-28: bumped 300 → 1000 to accommodate local reasoning models
            # (gemma4:e2b emits ~400-500 hidden reasoning tokens before any visible
            # content; 300 budget produced empty responses on longer prompts).
            max_tokens=1000,
            temperature=0.0,
            seed=qa_seed,
        ).strip()
    except Exception as e:
        return f"(error: {e})"
