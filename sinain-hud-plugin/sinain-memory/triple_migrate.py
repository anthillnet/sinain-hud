#!/usr/bin/env python3
"""One-shot historical data migration into the EAV triple store.

Migrates ~3 weeks of pre-triplestore data (playbook logs, daily memories,
playbook patterns, active modules) into the triple store so that triple_query
can surface historical context.

Idempotent: checks for a `migration:v1` stamp entity before running.
No embeddings: those accumulate organically at runtime.

Usage:
    python3 triple_migrate.py --memory-dir memory/ --modules-dir modules/ [--dry-run]
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure sibling imports work when invoked from workspace root
sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (
    _read_jsonl,
    list_daily_memory_files,
    read_effective_playbook,
    read_file_safe,
    output_json,
)
from triple_extractor import TripleExtractor
from triplestore import TripleStore

MIGRATION_ENTITY = "migration:v1"


def _assert_triples(store: TripleStore, tx_id: int, triples: list) -> int:
    """Assert a batch of Triple objects into the store. Returns count.

    Skips triples with None/empty entity_id or value (legacy data tolerance).
    """
    count = 0
    for t in triples:
        if t.value is None or t.entity_id is None:
            continue
        store.assert_triple(tx_id, t.entity_id, t.attribute, str(t.value), t.value_type)
        count += 1
    return count


def migrate_playbook(extractor: TripleExtractor, store: TripleStore, memory_dir: str) -> int:
    """Migrate the effective playbook into patterns. Returns triple count."""
    text = read_effective_playbook(memory_dir)
    if not text.strip():
        print("[migrate] no playbook found, skipping", file=sys.stderr)
        return 0
    triples = extractor.extract_playbook(text)
    if not triples:
        return 0
    tx = store.begin_tx("migration:playbook")
    return _assert_triples(store, tx, triples)


def migrate_modules(
    extractor: TripleExtractor, store: TripleStore, modules_dir: str
) -> tuple[int, int]:
    """Migrate active modules. Returns (module_count, triple_count)."""
    registry_path = Path(modules_dir) / "module-registry.json"
    if not registry_path.exists():
        print("[migrate] no module-registry.json, skipping modules", file=sys.stderr)
        return 0, 0

    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    modules = registry.get("modules", {})

    module_count = 0
    triple_count = 0

    for mod_id, entry in modules.items():
        if entry.get("status") != "active":
            continue

        manifest_path = Path(modules_dir) / mod_id / "manifest.json"
        patterns_path = Path(modules_dir) / mod_id / "patterns.md"

        manifest = {}
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                print(f"[migrate] bad manifest for {mod_id}, using empty", file=sys.stderr)

        patterns_text = read_file_safe(str(patterns_path))

        triples = extractor.extract_module(mod_id, manifest, patterns_text)
        if triples:
            tx = store.begin_tx(f"migration:module:{mod_id}")
            _assert_triples(store, tx, triples)
            triple_count += len(triples)
            module_count += 1

    return module_count, triple_count


def migrate_playbook_logs(
    extractor: TripleExtractor, store: TripleStore, memory_dir: str
) -> tuple[int, int]:
    """Migrate all playbook-log JSONL files. Returns (file_count, triple_count)."""
    log_dir = Path(memory_dir) / "playbook-logs"
    if not log_dir.is_dir():
        print("[migrate] no playbook-logs/ directory, skipping", file=sys.stderr)
        return 0, 0

    file_count = 0
    triple_count = 0

    for jsonl_file in sorted(log_dir.glob("*.jsonl")):
        entries = _read_jsonl(jsonl_file)
        if not entries:
            continue

        day_triples = []
        for entry in entries:
            # Skip idle entries with no signals
            if entry.get("idle", False) and not entry.get("signals"):
                continue

            ts = entry.get("ts", "")
            if not ts:
                continue

            # Normalize legacy string signals → dict format
            raw_signals = entry.get("signals", [])
            if raw_signals and isinstance(raw_signals[0], str):
                entry["signals"] = [
                    {"description": s, "priority": "medium"} for s in raw_signals
                ]

            day_triples.extend(extractor.extract_signal(entry, ts))

        if day_triples:
            tx = store.begin_tx(f"migration:logs:{jsonl_file.stem}")
            _assert_triples(store, tx, day_triples)
            triple_count += len(day_triples)
            file_count += 1
            print(f"  logs/{jsonl_file.name}: {len(day_triples)} triples", file=sys.stderr)

    return file_count, triple_count


def migrate_daily_memories(
    extractor: TripleExtractor, store: TripleStore, memory_dir: str
) -> tuple[int, int]:
    """Migrate YYYY-MM-DD.md daily memory files. Returns (file_count, triple_count)."""
    files = list_daily_memory_files(memory_dir)
    if not files:
        print("[migrate] no daily memory files, skipping", file=sys.stderr)
        return 0, 0

    file_count = 0
    triple_count = 0

    for filepath in files:
        text = read_file_safe(filepath)
        if not text.strip():
            continue

        date = Path(filepath).stem  # YYYY-MM-DD
        entity_id = f"observation:{date}"
        truncated = text[:2000]

        tx = store.begin_tx(f"migration:memory:{date}")

        # Core observation entity
        store.assert_triple(tx, entity_id, "text", truncated)
        store.assert_triple(tx, entity_id, "source", "daily_memory")
        count = 2

        # Extract and link concepts
        concept_triples = extractor.extract_concepts(truncated)
        for ct in concept_triples:
            store.assert_triple(tx, ct.entity_id, ct.attribute, ct.value, ct.value_type)
            count += 1
            if ct.entity_id.startswith("concept:"):
                store.assert_triple(tx, entity_id, "related_to", ct.entity_id, "ref")
                count += 1

        triple_count += count
        file_count += 1
        print(f"  memory/{date}.md: {count} triples", file=sys.stderr)

    return file_count, triple_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate historical data to triple store")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--modules-dir", default=None, help="Path to modules/ directory")
    parser.add_argument("--dry-run", action="store_true", help="Print plan without writing")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    modules_dir = args.modules_dir or str(Path(memory_dir).parent / "modules")

    db_path = str(Path(memory_dir) / "triplestore.db")
    if args.dry_run:
        print(f"[dry-run] would migrate into {db_path}", file=sys.stderr)
        print(f"  playbook: {read_effective_playbook(memory_dir)[:80]}...", file=sys.stderr)
        log_dir = Path(memory_dir) / "playbook-logs"
        if log_dir.is_dir():
            jsonl_files = list(log_dir.glob("*.jsonl"))
            print(f"  log files: {len(jsonl_files)}", file=sys.stderr)
        mem_files = list_daily_memory_files(memory_dir)
        print(f"  daily memories: {len(mem_files)}", file=sys.stderr)
        output_json({"dryRun": True, "dbPath": db_path})
        return

    store = TripleStore(db_path)
    extractor = TripleExtractor(store)

    # 1. Idempotency guard
    existing = store.entity(MIGRATION_ENTITY)
    if existing:
        print("[migrate] already migrated — migration:v1 entity exists", file=sys.stderr)
        output_json({"alreadyMigrated": True, **existing})
        store.close()
        return

    print("[migrate] starting historical data migration...", file=sys.stderr)

    # 2. Playbook
    pb_triples = migrate_playbook(extractor, store, memory_dir)
    print(f"[migrate] playbook: {pb_triples} triples", file=sys.stderr)

    # 3. Modules
    mod_count, mod_triples = migrate_modules(extractor, store, modules_dir)
    print(f"[migrate] modules: {mod_count} modules, {mod_triples} triples", file=sys.stderr)

    # 4. Playbook logs
    log_files, log_triples = migrate_playbook_logs(extractor, store, memory_dir)
    print(f"[migrate] logs: {log_files} files, {log_triples} triples", file=sys.stderr)

    # 5. Daily memories
    mem_files, mem_triples = migrate_daily_memories(extractor, store, memory_dir)
    print(f"[migrate] memories: {mem_files} files, {mem_triples} triples", file=sys.stderr)

    # 6. Stamp
    total_triples = pb_triples + mod_triples + log_triples + mem_triples
    stats = store.stats()
    stamp_tx = store.begin_tx("migration:stamp")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "completed_at", now)
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "playbook_triples", str(pb_triples))
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "module_count", str(mod_count))
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "log_files", str(log_files))
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "memory_files", str(mem_files))
    store.assert_triple(stamp_tx, MIGRATION_ENTITY, "total_triples", str(total_triples))

    store.close()

    # 7. Output
    output_json({
        "migrated": {
            "playbook": pb_triples,
            "modules": mod_count,
            "logs": log_files,
            "dailyMemory": mem_files,
        },
        "totalTriples": stats["triples"],
        "totalEntities": stats["entities"],
    })


if __name__ == "__main__":
    main()
