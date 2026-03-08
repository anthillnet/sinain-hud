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
