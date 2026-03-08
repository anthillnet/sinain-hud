#!/usr/bin/env python3
"""Triple Ingest — CLI entry point for ingesting data into the triple store.

Called by the sinain-hud plugin via runScript() for fire-and-forget ingestion.

Usage:
    python3 triple_ingest.py --memory-dir memory/ --signal-result '{"signals":[...]}' --tick-ts 2026-03-01T10:00:00Z
    python3 triple_ingest.py --memory-dir memory/ --ingest-playbook
    python3 triple_ingest.py --memory-dir memory/ --ingest-session '{"ts":"...","summary":"..."}'
    python3 triple_ingest.py --memory-dir memory/ --ingest-mining '{"newPatterns":[...]}'
    python3 triple_ingest.py --memory-dir memory/ --ingest-module react-native-dev --modules-dir modules/
    python3 triple_ingest.py --memory-dir memory/ --retract-module react-native-dev
    python3 triple_ingest.py --memory-dir memory/ --embed  (add --embed to any mode to trigger embedding)
"""

import argparse
import json
import sys
from pathlib import Path

# Ensure sinain-koog is on path for local imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from triplestore import TripleStore
from triple_extractor import TripleExtractor
from common import output_json, read_effective_playbook, read_file_safe


def _db_path(memory_dir: str) -> str:
    return str(Path(memory_dir) / "triplestore.db")


def _assert_triples(store: TripleStore, tx_id: int, triples: list) -> int:
    """Assert all triples in a transaction. Returns count."""
    count = 0
    for t in triples:
        store.assert_triple(tx_id, t.entity_id, t.attribute, t.value, t.value_type)
        count += 1
    return count


def _run_embeddings(store: TripleStore, memory_dir: str) -> None:
    """Run Phase 2 embeddings on recent entities (best-effort)."""
    try:
        from embedder import Embedder
        embedder = Embedder(_db_path(memory_dir))
        # Get entities from last transaction
        latest = store.latest_tx()
        if latest == 0:
            return
        novelties = store.novelty(max(0, latest - 1))
        entity_ids = list({n["entity_id"] for n in novelties})
        if not entity_ids:
            return

        # Build text for embedding
        entity_texts: dict[str, str] = {}
        for eid in entity_ids[:50]:  # cap at 50 per batch
            attrs = store.entity(eid)
            text = _build_embed_text(eid, attrs)
            if text:
                entity_texts[eid] = text

        if entity_texts:
            embedder.store_embeddings(entity_texts)
            print(f"[embed] Embedded {len(entity_texts)} entities", file=sys.stderr)
    except ImportError:
        print("[embed] embedder not available, skipping", file=sys.stderr)
    except Exception as e:
        print(f"[embed] Error: {e}", file=sys.stderr)


def _build_embed_text(entity_id: str, attrs: dict[str, list[str]]) -> str:
    """Build embedding source text from entity attributes.

    Templates per entity type (from design doc §5.3).
    """
    etype = entity_id.split(":")[0] if ":" in entity_id else "unknown"

    if etype == "pattern":
        text = attrs.get("text", [""])[0]
        concepts = ", ".join(attrs.get("related_to", []))
        return f"pattern: {text} (concepts: {concepts})" if text else ""

    if etype == "concept":
        name = attrs.get("name", [""])[0]
        return f"concept: {name}" if name else ""

    if etype == "session":
        summary = attrs.get("summary", [""])[0]
        return f"session: {summary}" if summary else ""

    if etype == "signal":
        desc = attrs.get("description", [""])[0]
        priority = attrs.get("priority", ["medium"])[0]
        return f"signal: {desc} (priority: {priority})" if desc else ""

    if etype == "guidance":
        text = attrs.get("text", [""])[0]
        return f"guidance: {text}" if text else ""

    if etype == "module":
        name = attrs.get("name", [""])[0]
        description = attrs.get("description", [""])[0]
        return f"module: {name} — {description}" if name else ""

    return ""


def cmd_signal(args: argparse.Namespace) -> None:
    """Ingest signal analysis result."""
    signal_data = json.loads(args.signal_result)
    store = TripleStore(_db_path(args.memory_dir))
    try:
        extractor = TripleExtractor(store)
        triples = extractor.extract_signal(signal_data, args.tick_ts)
        tx = store.begin_tx("signal_analyzer", metadata={"tick_ts": args.tick_ts})
        count = _assert_triples(store, tx, triples)
        if args.embed:
            _run_embeddings(store, args.memory_dir)
        output_json({"ingested": count, "entities": len({t.entity_id for t in triples}), "source": "signal", "txId": tx})
    finally:
        store.close()


def cmd_playbook(args: argparse.Namespace) -> None:
    """Ingest the current playbook."""
    playbook = read_effective_playbook(args.memory_dir)
    if not playbook:
        output_json({"ingested": 0, "source": "playbook", "error": "empty"})
        return
    store = TripleStore(_db_path(args.memory_dir))
    try:
        extractor = TripleExtractor(store)
        triples = extractor.extract_playbook(playbook)
        tx = store.begin_tx("playbook_curator")
        count = _assert_triples(store, tx, triples)
        if args.embed:
            _run_embeddings(store, args.memory_dir)
        output_json({"ingested": count, "entities": len({t.entity_id for t in triples}), "source": "playbook", "txId": tx})
    finally:
        store.close()


def cmd_session(args: argparse.Namespace) -> None:
    """Ingest a session summary."""
    session_data = json.loads(args.ingest_session)
    store = TripleStore(_db_path(args.memory_dir))
    try:
        extractor = TripleExtractor(store)
        triples = extractor.extract_session(session_data)
        tx = store.begin_tx("agent_end", metadata={"session": session_data.get("ts")})
        count = _assert_triples(store, tx, triples)
        if args.embed:
            _run_embeddings(store, args.memory_dir)
        output_json({"ingested": count, "entities": len({t.entity_id for t in triples}), "source": "session", "txId": tx})
    finally:
        store.close()


def cmd_mining(args: argparse.Namespace) -> None:
    """Ingest memory mining results."""
    mining_data = json.loads(args.ingest_mining)
    store = TripleStore(_db_path(args.memory_dir))
    try:
        extractor = TripleExtractor(store)
        triples = extractor.extract_mining(mining_data)
        tx = store.begin_tx("memory_miner")
        count = _assert_triples(store, tx, triples)
        if args.embed:
            _run_embeddings(store, args.memory_dir)
        output_json({"ingested": count, "entities": len({t.entity_id for t in triples}), "source": "mining", "txId": tx})
    finally:
        store.close()


def cmd_module(args: argparse.Namespace) -> None:
    """Ingest a module's patterns and guidance into the triple store."""
    modules_dir = Path(args.modules_dir)
    module_id = args.ingest_module
    manifest_path = modules_dir / module_id / "manifest.json"
    patterns_path = modules_dir / module_id / "patterns.md"
    guidance_path = modules_dir / module_id / "guidance.md"

    if not manifest_path.exists():
        output_json({"ingested": 0, "source": "module", "error": f"manifest not found: {manifest_path}"})
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    patterns_text = read_file_safe(str(patterns_path))
    guidance_text = read_file_safe(str(guidance_path))

    store = TripleStore(_db_path(args.memory_dir))
    try:
        extractor = TripleExtractor(store)
        triples = extractor.extract_module(module_id, manifest, patterns_text, guidance_text)
        tx = store.begin_tx("module_ingest", metadata={"module_id": module_id})
        count = _assert_triples(store, tx, triples)
        if args.embed:
            _run_embeddings(store, args.memory_dir)
        output_json({"ingested": count, "entities": len({t.entity_id for t in triples}), "source": "module", "module": module_id, "txId": tx})
    finally:
        store.close()


def cmd_retract_module(args: argparse.Namespace) -> None:
    """Retract a module's triples from the store."""
    module_id = args.retract_module
    entity_id = f"module:{module_id}"
    store = TripleStore(_db_path(args.memory_dir))
    try:
        tx = store.begin_tx("module_retract", metadata={"module_id": module_id})
        # Retract the module entity itself
        attrs = store.entity(entity_id)
        count = 0
        for attr in attrs:
            count += store.retract_triple(tx, entity_id, attr)
        # Retract patterns that belong_to this module
        backrefs = store.backrefs(entity_id, attribute="belongs_to")
        for pattern_eid, _ in backrefs:
            pattern_attrs = store.entity(pattern_eid)
            for attr in pattern_attrs:
                count += store.retract_triple(tx, pattern_eid, attr)
        output_json({"retracted": count, "source": "module", "module": module_id, "txId": tx})
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Triple Store Ingestion CLI")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--embed", action="store_true", help="Trigger embedding after ingestion")

    # Mutually exclusive ingestion modes
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--signal-result", help="JSON: signal analysis result")
    group.add_argument("--ingest-playbook", action="store_true", help="Ingest current playbook")
    group.add_argument("--ingest-session", help="JSON: session summary")
    group.add_argument("--ingest-mining", help="JSON: mining results")
    group.add_argument("--ingest-module", help="Module ID to ingest")
    group.add_argument("--retract-module", help="Module ID to retract")

    # Conditional args
    parser.add_argument("--tick-ts", help="Tick timestamp (required with --signal-result)")
    parser.add_argument("--modules-dir", help="Path to modules/ directory (required with --ingest-module)")

    args = parser.parse_args()

    if args.signal_result:
        if not args.tick_ts:
            parser.error("--tick-ts required with --signal-result")
        cmd_signal(args)
    elif args.ingest_playbook:
        cmd_playbook(args)
    elif args.ingest_session:
        cmd_session(args)
    elif args.ingest_mining:
        cmd_mining(args)
    elif args.ingest_module:
        if not args.modules_dir:
            parser.error("--modules-dir required with --ingest-module")
        cmd_module(args)
    elif args.retract_module:
        cmd_retract_module(args)


if __name__ == "__main__":
    main()
