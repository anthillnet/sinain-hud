"""Tests for triple_ingest.py — CLI entry point."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from triplestore import TripleStore


KOOG_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture
def memory_dir(tmp_path):
    """Create a temporary memory directory with playbook."""
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "sinain-playbook.md").write_text(
        "## Established Patterns\n"
        "- OCR pipeline stalls when queue depth > 10 (score: 0.8)\n"
        "- Use frame batching for throughput (score: 0.6)\n"
        "- Spawn research agent proactively\n",
        encoding="utf-8",
    )
    return str(mem)


@pytest.fixture
def modules_dir(tmp_path):
    """Create a temporary modules directory with a test module."""
    modules = tmp_path / "modules"
    modules.mkdir()
    mod_dir = modules / "test-mod"
    mod_dir.mkdir()
    (mod_dir / "manifest.json").write_text(json.dumps({
        "name": "Test Module",
        "description": "Testing patterns",
        "version": "1.0.0",
    }))
    (mod_dir / "patterns.md").write_text("## Patterns\n- Test pattern one\n- Test pattern two\n")
    return str(modules)


class TestSignalIngest:
    def test_signal_ingest_creates_db(self, memory_dir):
        signal = json.dumps({
            "signals": [{"description": "OCR stall", "priority": "high"}],
            "output": {"suggestion": "Try batching"},
        })
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--signal-result", signal,
             "--tick-ts", "2026-03-01T10:00:00Z"],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["ingested"] > 0
        assert data["source"] == "signal"
        assert "txId" in data
        # DB should exist
        assert Path(memory_dir, "triplestore.db").exists()

    def test_signal_ingest_requires_tick_ts(self, memory_dir):
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--signal-result", '{"signals":[]}'],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode != 0


class TestPlaybookIngest:
    def test_playbook_ingest(self, memory_dir):
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-playbook"],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["ingested"] > 0
        assert data["source"] == "playbook"


class TestSessionIngest:
    def test_session_ingest(self, memory_dir):
        session = json.dumps({
            "ts": "2026-03-01T09:00:00Z",
            "summary": "Debugging OCR pipeline issues",
            "toolsUsed": ["Read", "Edit"],
        })
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-session", session],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["ingested"] > 0
        assert data["source"] == "session"


class TestMiningIngest:
    def test_mining_ingest(self, memory_dir):
        mining = json.dumps({
            "newPatterns": ["Frame dropping improves OCR"],
            "preferences": ["User prefers minimal output"],
            "contradictions": [],
        })
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-mining", mining],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["ingested"] > 0
        assert data["source"] == "mining"


class TestModuleIngest:
    def test_module_ingest(self, memory_dir, modules_dir):
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-module", "test-mod",
             "--modules-dir", modules_dir],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["ingested"] > 0
        assert data["source"] == "module"
        assert data["module"] == "test-mod"

    def test_module_requires_modules_dir(self, memory_dir):
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-module", "test-mod"],
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode != 0


class TestRetractModule:
    def test_retract_module(self, memory_dir, modules_dir):
        # First ingest
        subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--ingest-module", "test-mod",
             "--modules-dir", modules_dir],
            capture_output=True, text=True, timeout=30,
        )
        # Then retract
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--retract-module", "test-mod"],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout.strip())
        assert data["source"] == "module"
        assert data["module"] == "test-mod"


class TestOutputFormat:
    def test_output_is_valid_json(self, memory_dir):
        signal = json.dumps({"signals": []})
        result = subprocess.run(
            [sys.executable, str(KOOG_DIR / "triple_ingest.py"),
             "--memory-dir", memory_dir,
             "--signal-result", signal,
             "--tick-ts", "2026-03-01"],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout.strip())
        assert isinstance(data, dict)
        assert "ingested" in data
        assert "source" in data


# ---------------------------------------------------------------------------
# Entity canonicalization tests
# ---------------------------------------------------------------------------


class TestNormalizeEntity:
    """Tests for _normalize_entity() Unicode transliteration."""

    def test_ascii_unchanged(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("hello-world") == "hello-world"
        assert _normalize_entity("JetBrains") == "jetbrains"
        assert _normalize_entity("Google Meet") == "google-meet"

    def test_german_umlaut(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("Übungsbuch") == "ubungsbuch"
        assert _normalize_entity("Hauptstraße") == "hauptstrasse"
        assert _normalize_entity("Bemaßter") == "bemasster"
        assert _normalize_entity("Köln") == "koln"
        assert _normalize_entity("Müller") == "muller"

    def test_accented_chars(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("François") == "francois"
        assert _normalize_entity("café") == "cafe"
        assert _normalize_entity("naïve") == "naive"

    def test_consecutive_hyphens_collapsed(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("kurs- und Übungsbuch") == "kurs-und-ubungsbuch"
        assert _normalize_entity("a--b---c") == "a-b-c"

    def test_leading_trailing_hyphens_stripped(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("-hello-") == "hello"
        assert _normalize_entity("--test--") == "test"

    def test_underscores_to_hyphens(self):
        from knowledge_integrator import _normalize_entity
        assert _normalize_entity("audio_midi_setup") == "audio-midi-setup"


class TestFindMatchingEntity:
    """Tests for _find_matching_entity() fuzzy matching."""

    def test_exact_match(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"blinklearning": "entity:blinklearning"}
        assert _find_matching_entity("blinklearning", entities) == "entity:blinklearning"

    def test_hyphen_insensitive(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"chat-gpt": "entity:chat-gpt"}
        assert _find_matching_entity("chatgpt", entities) == "entity:chat-gpt"

    def test_hyphen_insensitive_reverse(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"chatgpt": "entity:chatgpt"}
        assert _find_matching_entity("chat-gpt", entities) == "entity:chatgpt"

    def test_typo_match(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"blinklearning": "entity:blinklearning"}
        assert _find_matching_entity("blinkslearning", entities) == "entity:blinklearning"

    def test_name_variant(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"dmitriy": "entity:dmitriy"}
        # dmitri vs dmitriy: ratio = 0.857 > 0.85 threshold
        assert _find_matching_entity("dmitri", entities) == "entity:dmitriy"

    def test_model_version_variant(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"gemma-34b": "entity:gemma-34b"}
        # gemma34b vs gemma-34b: hyphen-insensitive match
        assert _find_matching_entity("gemma34b", entities) == "entity:gemma-34b"

    def test_no_false_positive_short(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"git": "entity:git"}
        assert _find_matching_entity("got", entities) is None

    def test_no_false_positive_dissimilar(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"palo": "entity:palo"}
        # polo vs palo: ratio = 0.75 < 0.90 threshold
        assert _find_matching_entity("polo", entities) is None

    def test_no_false_positive_shared_suffix(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"claude-code": "entity:claude-code"}
        # cloud-code vs claude-code: ratio = 0.857 < 0.90 threshold
        assert _find_matching_entity("cloud-code", entities) is None

    def test_no_false_positive_different_prefix(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"it-bank": "entity:it-bank"}
        # td-bank vs it-bank: ratio = 0.857 < 0.90
        assert _find_matching_entity("td-bank", entities) is None

    def test_empty_existing(self):
        from knowledge_integrator import _find_matching_entity
        assert _find_matching_entity("anything", {}) is None

    def test_short_names_skipped(self):
        from knowledge_integrator import _find_matching_entity
        entities = {"ab": "entity:ab"}
        assert _find_matching_entity("ac", entities) is None
