"""Integrator ablation stub. Bypasses knowledge_integrator.py LLM call by
mechanically translating distiller facts → triplestore.assert_triple calls.

Modes:
    passthrough: each fact → one assert with confidence=0.8 (mirrors what
                 knowledge_integrator's deterministic step does AFTER its LLM
                 step). Tests: "what if no LLM reasoning happened in the
                 integrator (no merge/retract/playbook)?"
    oracle:      same shape, confidence=1.0, no dedup. Tests: "what if
                 integration was perfect lossless asserting?"
"""
from __future__ import annotations
import sys
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)


def apply_stub_integration(
    memory_dir: Path,
    digest: dict,
    mode: str = "passthrough",
) -> None:
    """Apply a stub integration: distiller facts → assert_triple calls.

    Memory dir must exist; DB file created if needed.
    """
    from triplestore import TripleStore

    memory_dir = Path(memory_dir)
    memory_dir.mkdir(parents=True, exist_ok=True)
    db_path = str(memory_dir / "memory.db")
    store = TripleStore(db_path)
    tx = store.begin_tx("ablation:integrator")
    confidence = 1.0 if mode == "oracle" else 0.8

    facts = digest.get("facts", []) if isinstance(digest, dict) else []
    for fact in facts:
        entity = fact.get("entity")
        attribute = fact.get("attribute", "value")
        value = fact.get("value", "")
        if not entity:
            continue
        try:
            store.assert_triple(
                tx,
                entity_id=str(entity),
                attribute=str(attribute),
                value=str(value),
                confidence=confidence,
            )
        except TypeError:
            store.assert_triple(tx, str(entity), str(attribute), str(value))
    store.commit_tx(tx)
