"""SmolLM2-360M-based multi-query probe + HyDE hypothesis generation.

Tier 3 of the deterministic-offload analysis (per .planning/phases/diarization-
levers/00-PLAN.md § Unified execution order). Replaces the cloud LLM rewriter
(`query_rewriter.py`, bench-confirmed null on acme AND LongMemEval q3+q4)
with a dedicated tiny model that operates LOCALLY at zero per-query API cost.

Architecture:
    User query → SmolLM2-360M → {probes: [paraphrase_1..N], hypothesis: str}
                      ↓
    Probes run as additional FTS5 queries (widens candidate funnel)
    Hypothesis seeds the bi-encoder rerank (replaces raw query embedding)

Why SmolLM2-360M specifically:
    - Per GPT report on micro-model orchestration: 360M is "the smallest
      actually useful utility model" for paraphrase/transform tasks
    - ~725MB on disk, ~300MB active RAM
    - ~700ms inference for ~50 input + ~50 output tokens
    - Runs in parallel with phi4-mini (no shared queue contention)
    - Zero per-query API cost (local Ollama)

The probe-gen task is the EASIEST kind of language transformation —
preserving meaning while varying phrasing. Smoke-tested on the GPT-report-
recommended size; produces clean statement-form paraphrases of question-form
queries, which is exactly what HyDE wants (move embedding into fact space).
"""

from __future__ import annotations

import json
import os
import re
import sys
import requests
from typing import Any


# SmolLM2:latest (1.7B) is the validated default — bench-tested 2026-05-28
# evening, produces clean probes + hypothesis on both acme and
# LongMemEval-S q3+q4. The 360m variant produced inconsistent output
# (empty response on q3 with the $5 symbol). 1.7B is still tiny by LLM
# standards (1.8GB disk, ~700ms inference) and parallelizable with phi4-mini.
PROBE_MODEL = os.environ.get("SINAIN_PROBE_MODEL", "smollm2:latest")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
# Native /api/chat, not the OpenAI-compat /v1: only the native API accepts
# `think: false`, which reasoning models need to emit content at all.
_CHAT_URL = f"{OLLAMA_BASE_URL.rstrip('/')}/api/chat"


PROBE_SYSTEM_PROMPT = """\
You rewrite a question into 3 statement-form paraphrases AND 1 hypothetical \
answer-shaped fact. Statement-form means the rewrite asserts what's being asked \
about, instead of asking. Hypothetical answer means a sentence that would \
ANSWER the question if filled with specific details.

Example:
  Question: "What play did I attend at the local community theater?"
  Output:
    1. I attended a play at the local community theater.
    2. The play I went to see was performed at the local community theater.
    3. My visit to the local community theater was for a play.
    HYPOTHESIS: The user attended [PLAY TITLE] at the local community theater. The play was performed by a community group.

Always output exactly 3 numbered paraphrases (statement form, declarative, no \
question marks) followed by one line starting with HYPOTHESIS: that fills in \
generic placeholders for unknown specifics.
"""


def _parse_response(text: str) -> tuple[list[str], str]:
    """Extract 3 probes + hypothesis from a SmolLM response."""
    probes: list[str] = []
    hypothesis = ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # Match "1. probe" / "2. probe" / "3. probe"
        m = re.match(r"^(?:[1-9][.)]\s*)(.+)$", line)
        if m and not line.upper().startswith("HYPOTHESIS"):
            probe = m.group(1).strip().strip('"“”')
            if probe and not probe.endswith("?"):
                probes.append(probe)
            continue
        # Match "HYPOTHESIS: ..."
        if line.upper().startswith("HYPOTHESIS:"):
            hypothesis = line.split(":", 1)[1].strip().strip('"“”')
    return probes[:3], hypothesis


def generate_probes_and_hypothesis(
    question: str,
    *,
    model: str = PROBE_MODEL,
    timeout: float = 30.0,
    fallback: bool = True,
) -> tuple[list[str], str]:
    """Return (probes, hypothesis) for a user question.

    probes: 3 statement-form paraphrases for FTS5 funnel widening.
    hypothesis: 1 fact-shaped sentence for bi-encoder embedding seed (HyDE).

    On any failure (Ollama unavailable, timeout, parse error), returns
    ([], "") so the caller can no-op to standard retrieval. Set
    fallback=False to raise instead.
    """
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": PROBE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Question: {question.strip()}"},
        ],
        "stream": False,
        "think": False,
        "options": {"temperature": 0.2, "num_predict": 250},
    }
    try:
        r = requests.post(_CHAT_URL, json=payload, timeout=timeout)
        r.raise_for_status()
        text = r.json()["message"]["content"]
    except Exception as e:
        if not fallback:
            raise
        print(f"[probe-gen] {model} failed (non-fatal): {e}", file=sys.stderr)
        return [], ""

    probes, hypothesis = _parse_response(text)
    if not probes and not hypothesis and fallback:
        print(f"[probe-gen] parse miss; raw output: {text[:200]!r}", file=sys.stderr)
        return [], ""
    return probes, hypothesis


def is_enabled() -> bool:
    """SINAIN_SMOLLM_PROBES=1 opt-in gate."""
    return os.environ.get("SINAIN_SMOLLM_PROBES", "").lower() in ("1", "true", "yes")


if __name__ == "__main__":
    # CLI smoke test: python3 query_smollm.py "<question>"
    q = sys.argv[1] if len(sys.argv) > 1 else "What play did I attend at the local community theater?"
    probes, hypothesis = generate_probes_and_hypothesis(q, fallback=False)
    print(f"Question: {q}\n")
    print("Probes:")
    for i, p in enumerate(probes, 1):
        print(f"  {i}. {p}")
    print(f"\nHypothesis: {hypothesis}")
