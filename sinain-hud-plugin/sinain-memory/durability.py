"""Durability gates — the code-level filter between "worth remembering" and
"presence data" (docs/DESIGN-MEMORY-V2.md; mem0 lesson: gates live in code,
not in prompt hopes).

Single source of truth for the narration signature, shared by
memory_v2/compact.py (T2 compaction) and knowledge_integrator.py (legacy
distillation path). The two-week test in regex form: a claim about what the
user IS DOING RIGHT NOW is T1 episode material, never a T2 fact.
"""
from __future__ import annotations

import re

# Activity narration: generic subject + activity verb ("The user was browsing
# Gmail", "activity: editing X in Zed", "User ran the command ...") plus the
# on-screen/present-state variants observed in production junk ("The user is
# on a login screen", "The user is currently idle").
NARRATION_RE = re.compile(
    r"^(?:activity:|the (?:user|agent)\b.*?\b(?:was|is|were|began|continued|ran the command)\b"
    r".*?\b(?:brows|view|edit|review|read|work|watch|scroll|check|open|navigat|typ|us)"
    r"|(?:user|the user) (?:browsed|viewed|edited|reviewed|read|watched|scrolled|checked|opened|navigated|ran|executed)"
    r"|the (?:user|agent) is (?:currently|now)\b"
    r"|the (?:user|agent) is (?:on|at|in) (?:a|an|the)\b.*?\b(?:screen|page|tab|window|site|dashboard|view)\b)",
    re.IGNORECASE,
)

# Truncated / stub claims ("The user is") — an LLM ran out of tokens or the
# sentence lost its object; nothing durable can end on a copula/preposition.
_STUB_TAIL = re.compile(
    r"\b(?:is|are|was|were|the|a|an|of|to|in|on|for|with|and|or|about)\s*[.…]?$",
    re.IGNORECASE,
)


def is_ephemeral(text: str) -> bool:
    """True when a distilled claim is presence data or a stub — route it to
    T1 episodes (or drop it; the transcript escrow already holds it), never
    into the knowledge graph."""
    t = (text or "").strip()
    if len(t) < 12:
        return True
    if NARRATION_RE.search(t):
        return True
    if len(t) < 40 and _STUB_TAIL.search(t):
        return True
    return False
