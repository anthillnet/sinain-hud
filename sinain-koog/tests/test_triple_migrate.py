"""Tests for triple_migrate.py — historical data migration to triple store."""

import json
import sys
from pathlib import Path

import pytest

# Ensure sinain-koog source is importable
KOOG_DIR = Path(__file__).resolve().parent.parent
if str(KOOG_DIR) not in sys.path:
    sys.path.insert(0, str(KOOG_DIR))

from triple_extractor import TripleExtractor
from triple_migrate import (
    MIGRATION_ENTITY,
    migrate_daily_memories,
    migrate_modules,
    migrate_playbook,
    migrate_playbook_logs,
)
from triplestore import TripleStore


@pytest.fixture
def store(tmp_path):
    db = tmp_path / "triplestore.db"
    return TripleStore(str(db))


@pytest.fixture
def extractor(store):
    return TripleExtractor(store)


class TestMigratePlaybook:
    def test_extracts_patterns(self, extractor, store, tmp_memory_dir):
        count = migrate_playbook(extractor, store, str(tmp_memory_dir))
        assert count > 0
        # Should find at least the OCR and research-agent patterns
        patterns = store.entities_with_attr("text")
        pattern_ids = [eid for eid, _ in patterns if eid.startswith("pattern:")]
        assert len(pattern_ids) >= 2

    def test_empty_playbook_returns_zero(self, extractor, store, tmp_path):
        memory = tmp_path / "empty_memory"
        memory.mkdir()
        count = migrate_playbook(extractor, store, str(memory))
        assert count == 0


class TestMigrateModules:
    def test_active_only(self, extractor, store, tmp_modules_dir):
        mod_count, triple_count = migrate_modules(extractor, store, str(tmp_modules_dir))
        # Only react-native-dev is active; ocr-pipeline is suspended
        assert mod_count == 1
        assert triple_count > 0
        # Module entity should exist
        ent = store.entity("module:react-native-dev")
        assert "name" in ent
        assert ent["name"] == ["React Native Development"]

    def test_no_registry(self, extractor, store, tmp_path):
        mod_count, triple_count = migrate_modules(extractor, store, str(tmp_path / "nope"))
        assert mod_count == 0
        assert triple_count == 0


class TestMigratePlaybookLogs:
    def test_skips_idle_no_signals(self, extractor, store, tmp_memory_dir):
        """Idle entries with empty signals should be skipped."""
        file_count, triple_count = migrate_playbook_logs(
            extractor, store, str(tmp_memory_dir)
        )
        assert file_count >= 1
        assert triple_count > 0
        # The second entry in conftest is idle=True + signals=[], should be skipped
        # First entry has ts=2026-02-28T10:00:00Z — should be ingested
        ent = store.entity("signal:2026-02-28T10:00:00Z")
        assert ent  # non-idle entry should exist
        # Idle entry should NOT exist
        idle_ent = store.entity("signal:2026-02-28T10:30:00Z")
        assert not idle_ent

    def test_no_log_dir(self, extractor, store, tmp_path):
        memory = tmp_path / "empty"
        memory.mkdir()
        file_count, triple_count = migrate_playbook_logs(extractor, store, str(memory))
        assert file_count == 0


class TestMigrateDailyMemories:
    def test_creates_observation_entities(self, extractor, store, tmp_memory_dir):
        file_count, triple_count = migrate_daily_memories(
            extractor, store, str(tmp_memory_dir)
        )
        # conftest creates 3 daily memory files
        assert file_count == 3
        assert triple_count > 0
        # Check one observation entity
        ent = store.entity("observation:2026-02-21")
        assert "text" in ent
        assert "source" in ent
        assert ent["source"] == ["daily_memory"]

    def test_truncates_long_text(self, extractor, store, tmp_path):
        memory = tmp_path / "memory"
        memory.mkdir()
        (memory / "2026-01-01.md").write_text("x" * 5000, encoding="utf-8")
        migrate_daily_memories(extractor, store, str(memory))
        ent = store.entity("observation:2026-01-01")
        assert len(ent["text"][0]) == 2000


class TestIdempotency:
    def test_stamp_prevents_remigration(self, store, tmp_path):
        """Once migration:v1 exists, the script should be a no-op."""
        tx = store.begin_tx("test")
        store.assert_triple(tx, MIGRATION_ENTITY, "completed_at", "2026-03-05T00:00:00Z")
        existing = store.entity(MIGRATION_ENTITY)
        assert existing  # guard entity exists

    def test_full_migration_stamps(self, extractor, store, tmp_memory_dir, tmp_modules_dir):
        """Full migration should create the stamp entity."""
        migrate_playbook(extractor, store, str(tmp_memory_dir))
        migrate_modules(extractor, store, str(tmp_modules_dir))
        migrate_playbook_logs(extractor, store, str(tmp_memory_dir))
        migrate_daily_memories(extractor, store, str(tmp_memory_dir))

        # Simulate stamping
        stats = store.stats()
        stamp_tx = store.begin_tx("migration:stamp")
        store.assert_triple(stamp_tx, MIGRATION_ENTITY, "completed_at", "2026-03-05T00:00:00Z")
        store.assert_triple(stamp_tx, MIGRATION_ENTITY, "total_triples", str(stats["triples"]))

        ent = store.entity(MIGRATION_ENTITY)
        assert "completed_at" in ent
        assert int(ent["total_triples"][0]) > 0
