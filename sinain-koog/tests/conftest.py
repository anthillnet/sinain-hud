"""Shared fixtures for sinain-koog pytest test suite."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Ensure sinain-koog source is importable
KOOG_DIR = Path(__file__).resolve().parent.parent
if str(KOOG_DIR) not in sys.path:
    sys.path.insert(0, str(KOOG_DIR))


@pytest.fixture
def tmp_memory_dir(tmp_path):
    """Create a temporary memory directory with sample data."""
    memory = tmp_path / "memory"
    memory.mkdir()
    (memory / "playbook-logs").mkdir()
    (memory / "playbook-archive").mkdir()
    (memory / "eval-logs").mkdir()
    (memory / "eval-reports").mkdir()

    # Sample playbook
    playbook = (
        "<!-- mining-index: 2026-02-21,2026-02-20 -->\n"
        "# Sinain Playbook\n\n"
        "## Established Patterns\n"
        "- When OCR pipeline stalls, check camera frame queue depth (score: 0.8)\n"
        "- When user explores new framework, spawn research agent proactively (score: 0.6)\n\n"
        "## Observed\n"
        "- User prefers concise Telegram messages over detailed ones\n"
        "- Late evening sessions tend to be exploratory/research-heavy\n\n"
        "## Stale\n"
        "- Flutter overlay rendering glitch on macOS 15 [since: 2026-02-18]\n\n"
        "<!-- effectiveness: outputs=8,positive=5,negative=1,neutral=2,rate=0.63,updated=2026-02-21 -->\n"
    )
    (memory / "sinain-playbook.md").write_text(playbook, encoding="utf-8")

    # Sample daily memory files
    for date in ["2026-02-21", "2026-02-20", "2026-02-19"]:
        (memory / f"{date}.md").write_text(
            f"# {date} Session Notes\n\n- Worked on OCR pipeline\n- Explored Flutter overlays\n",
            encoding="utf-8",
        )

    # Sample playbook-log entries
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entries = [
        {
            "ts": "2026-02-28T10:00:00Z",
            "idle": False,
            "sessionSummary": "Debugging OCR pipeline",
            "signals": [{"description": "OCR pipeline backpressure detected", "priority": "high"}],
            "recommendedAction": {"action": "sessions_spawn", "task": "Debug OCR backpressure", "confidence": 0.8},
            "feedbackScores": {"avg": 0.35, "high": ["OCR fix"], "low": []},
            "effectiveness": {"outputs": 8, "positive": 5, "negative": 1, "neutral": 2, "rate": 0.63},
            "curateDirective": "normal",
            "playbookChanges": {
                "changes": {"added": ["new pattern"], "pruned": [], "promoted": []},
                "staleItemActions": [],
                "playbookLines": 12,
            },
            "output": {
                "skip": False,
                "suggestion": "Consider frame batching for OCR pipeline",
                "insight": "Evening sessions correlate with exploratory work patterns",
                "totalChars": 95,
            },
            "skipped": False,
            "actionsConsidered": [
                {"action": "sessions_spawn", "reason": "Debug OCR backpressure", "chosen": True}
            ],
        },
        {
            "ts": "2026-02-28T10:30:00Z",
            "idle": True,
            "sessionSummary": "User idle",
            "signals": [],
            "recommendedAction": None,
            "feedbackScores": {"avg": 0, "high": [], "low": []},
            "effectiveness": {"outputs": 8, "positive": 5, "negative": 1, "neutral": 2, "rate": 0.63},
            "curateDirective": "normal",
            "playbookChanges": {
                "changes": {"added": [], "pruned": [], "promoted": []},
                "staleItemActions": [],
                "playbookLines": 12,
            },
            "output": {
                "skip": True,
                "skipReason": "User is idle and no new patterns detected in playbook since last analysis",
            },
            "skipped": True,
            "miningResult": {
                "findings": "Found cross-day OCR pattern",
                "newPatterns": ["frame dropping improves OCR accuracy"],
                "contradictions": [],
                "preferences": ["user prefers minimal configs"],
                "minedSources": ["2026-02-21.md"],
            },
            "actionsConsidered": [],
        },
    ]

    log_file = memory / "playbook-logs" / f"{today}.jsonl"
    log_file.write_text(
        "\n".join(json.dumps(e) for e in entries) + "\n",
        encoding="utf-8",
    )

    return memory


@pytest.fixture
def tmp_modules_dir(tmp_path):
    """Create a temporary modules directory with sample module."""
    modules = tmp_path / "modules"
    modules.mkdir()

    # Registry
    registry = {
        "version": 1,
        "modules": {
            "react-native-dev": {
                "status": "active",
                "priority": 85,
                "activatedAt": "2026-02-20T10:00:00Z",
                "lastTriggered": None,
                "locked": False,
            },
            "ocr-pipeline": {
                "status": "suspended",
                "priority": 70,
                "activatedAt": None,
                "lastTriggered": None,
                "locked": False,
            },
        },
    }
    (modules / "module-registry.json").write_text(
        json.dumps(registry, indent=2), encoding="utf-8"
    )

    # Module directories
    rn_dir = modules / "react-native-dev"
    rn_dir.mkdir()
    (rn_dir / "manifest.json").write_text(json.dumps({
        "id": "react-native-dev",
        "name": "React Native Development",
        "description": "Patterns for RN development",
        "version": "1.0.0",
        "priority": {"default": 85, "range": [50, 100]},
        "triggers": {},
        "locked": False,
    }, indent=2), encoding="utf-8")
    (rn_dir / "patterns.md").write_text(
        "# React Native Development\n\n## Established Patterns\n- Use Hermes engine\n",
        encoding="utf-8",
    )

    return modules


@pytest.fixture
def sample_log_entry():
    """A sample playbook-log entry for testing."""
    return {
        "ts": "2026-02-28T10:00:00Z",
        "idle": False,
        "signals": [{"description": "OCR pipeline backpressure detected", "priority": "high"}],
        "recommendedAction": {"action": "sessions_spawn", "task": "Debug OCR backpressure", "confidence": 0.8},
        "feedbackScores": {"avg": 0.35, "high": ["OCR fix"], "low": []},
        "effectiveness": {"outputs": 8, "positive": 5, "negative": 1, "neutral": 2, "rate": 0.63},
        "curateDirective": "normal",
        "interpretation": "",
        "playbookChanges": {
            "changes": {"added": ["new pattern"], "pruned": [], "promoted": []},
            "staleItemActions": [],
            "playbookLines": 12,
        },
        "output": {
            "skip": False,
            "suggestion": "Consider frame batching for OCR pipeline",
            "insight": "Evening sessions correlate with exploratory work patterns",
            "totalChars": 95,
        },
    }
