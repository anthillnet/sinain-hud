"""Query pipeline — benchmark questions → LLM answers under 3 conditions.

Condition A (sinain-memory): answer from knowledge graph facts
Condition B (full-context):  answer from full conversation history
Condition C (knowledge-doc): answer from portable knowledge document
"""

from __future__ import annotations

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


def _query_knowledge(db_path: str, question: str) -> str:
    """Query sinain knowledge graph for facts relevant to a question.

    Strategy: retrieve broadly, then re-rank by keyword overlap with the question.
    This ensures specific facts (CTO background) beat generic ones (meeting schedule)
    when the question asks about the CTO.
    """
    from graph_query import query_facts_hybrid, query_top_facts, format_facts_text

    # Retrieve a broad candidate set
    candidates = query_facts_hybrid(db_path, question, max_facts=30)
    if not candidates:
        candidates = query_top_facts(db_path, limit=30)
    if not candidates:
        return "(no knowledge available)"

    # Re-rank by keyword overlap between question and fact value
    q_keywords = set(_extract_keywords(question))
    def _relevance(fact: dict) -> float:
        value = str(fact.get("value", "")).lower()
        entity = str(fact.get("entity", "")).lower()
        fact_words = set(_extract_keywords(value + " " + entity))
        if not q_keywords:
            return 0.0
        return len(q_keywords & fact_words) / len(q_keywords)

    ranked = sorted(candidates, key=_relevance, reverse=True)
    return format_facts_text(ranked[:MAX_FACTS_PER_QUERY], max_chars=3000)


def _get_retrieved_facts(db_path: str, question: str, k: int = 10) -> list[dict]:
    """Get facts retrieved for a question (for retrieval evaluation)."""
    from graph_query import query_facts_hybrid, query_top_facts

    facts = query_facts_hybrid(db_path, question, max_facts=k)
    if facts:
        return facts

    # Fallback: top facts by confidence
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
) -> str:
    """Generate an answer for a benchmark question under a specific condition.

    Returns the LLM's answer text.
    """
    qa_model = model or QA_MODEL

    if condition == "sinain-memory":
        assert db_path, "db_path required for sinain-memory condition"
        facts = _query_knowledge(db_path, question.text)
        system = (
            "Answer the question using ONLY the provided knowledge facts. "
            "If the facts don't contain enough information to answer, say \"I don't know.\""
        )
        user = f"## Knowledge Facts\n{facts}\n\n## Question\n{question.text}"

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
        return call_llm(
            system_prompt=system,
            user_prompt=user,
            model=qa_model,
            max_tokens=300,
        ).strip()
    except Exception as e:
        return f"(error: {e})"
