"""Tests for module_manager.py: management commands (no LLM)."""

import json
from pathlib import Path
from io import StringIO
from unittest.mock import patch
import argparse
import pytest

from module_manager import (
    cmd_list,
    cmd_activate,
    cmd_suspend,
    cmd_priority,
    cmd_stack,
    cmd_info,
    _load_registry,
    _save_registry,
)


def _capture_stdout(func, modules_dir, args_dict=None):
    """Call a command function and capture its stdout JSON."""
    args = argparse.Namespace(**(args_dict or {}))
    with patch("sys.stdout", new_callable=StringIO) as mock_out:
        func(modules_dir, args)
        return json.loads(mock_out.getvalue())


class TestCmdList:
    def test_lists_all_modules(self, tmp_modules_dir):
        result = _capture_stdout(cmd_list, tmp_modules_dir)
        modules = result["modules"]
        ids = [m["id"] for m in modules]
        assert "react-native-dev" in ids
        assert "ocr-pipeline" in ids

    def test_shows_status(self, tmp_modules_dir):
        result = _capture_stdout(cmd_list, tmp_modules_dir)
        modules = {m["id"]: m for m in result["modules"]}
        assert modules["react-native-dev"]["status"] == "active"
        assert modules["ocr-pipeline"]["status"] == "suspended"

    def test_empty_registry(self, tmp_path):
        modules = tmp_path / "modules"
        modules.mkdir()
        result = _capture_stdout(cmd_list, modules)
        assert result["modules"] == []


class TestCmdActivate:
    def test_activate_suspended_module(self, tmp_modules_dir):
        # Create manifest for ocr-pipeline
        ocr_dir = tmp_modules_dir / "ocr-pipeline"
        ocr_dir.mkdir(exist_ok=True)
        (ocr_dir / "manifest.json").write_text(json.dumps({
            "id": "ocr-pipeline", "name": "OCR Pipeline",
            "priority": {"default": 70, "range": [50, 100]},
        }))

        result = _capture_stdout(cmd_activate, tmp_modules_dir, {"module_id": "ocr-pipeline", "priority": None})
        assert result["activated"] == "ocr-pipeline"
        assert result["status"] == "active"

        reg = _load_registry(tmp_modules_dir)
        assert reg["modules"]["ocr-pipeline"]["status"] == "active"

    def test_activate_with_custom_priority(self, tmp_modules_dir):
        ocr_dir = tmp_modules_dir / "ocr-pipeline"
        ocr_dir.mkdir(exist_ok=True)
        (ocr_dir / "manifest.json").write_text(json.dumps({
            "id": "ocr-pipeline", "name": "OCR Pipeline",
            "priority": {"default": 70, "range": [50, 100]},
        }))

        result = _capture_stdout(cmd_activate, tmp_modules_dir, {"module_id": "ocr-pipeline", "priority": 90})
        assert result["priority"] == 90

    def test_activate_out_of_range(self, tmp_modules_dir):
        ocr_dir = tmp_modules_dir / "ocr-pipeline"
        ocr_dir.mkdir(exist_ok=True)
        (ocr_dir / "manifest.json").write_text(json.dumps({
            "id": "ocr-pipeline", "name": "OCR Pipeline",
            "priority": {"default": 70, "range": [50, 100]},
        }))

        with pytest.raises(SystemExit):
            _capture_stdout(cmd_activate, tmp_modules_dir, {"module_id": "ocr-pipeline", "priority": 200})


class TestCmdSuspend:
    def test_suspend_active_module(self, tmp_modules_dir):
        result = _capture_stdout(cmd_suspend, tmp_modules_dir, {"module_id": "react-native-dev"})
        assert result["suspended"] == "react-native-dev"

        reg = _load_registry(tmp_modules_dir)
        assert reg["modules"]["react-native-dev"]["status"] == "suspended"

    def test_suspend_locked_module(self, tmp_modules_dir):
        reg = _load_registry(tmp_modules_dir)
        reg["modules"]["react-native-dev"]["locked"] = True
        _save_registry(tmp_modules_dir, reg)

        with pytest.raises(SystemExit):
            _capture_stdout(cmd_suspend, tmp_modules_dir, {"module_id": "react-native-dev"})

    def test_suspend_nonexistent(self, tmp_modules_dir):
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_suspend, tmp_modules_dir, {"module_id": "nonexistent"})


class TestCmdPriority:
    def test_change_priority(self, tmp_modules_dir):
        result = _capture_stdout(cmd_priority, tmp_modules_dir,
                                 {"module_id": "react-native-dev", "new_priority": 95})
        assert result["priority"] == 95

        reg = _load_registry(tmp_modules_dir)
        assert reg["modules"]["react-native-dev"]["priority"] == 95


class TestCmdStack:
    def test_shows_active_and_suspended(self, tmp_modules_dir):
        result = _capture_stdout(cmd_stack, tmp_modules_dir)
        assert len(result["active"]) == 1
        assert result["active"][0]["id"] == "react-native-dev"
        assert len(result["suspended"]) == 1

    def test_sorted_by_priority_desc(self, tmp_modules_dir):
        # Add another active module
        reg = _load_registry(tmp_modules_dir)
        reg["modules"]["other-module"] = {
            "status": "active", "priority": 95, "locked": False,
            "activatedAt": None, "lastTriggered": None,
        }
        _save_registry(tmp_modules_dir, reg)

        result = _capture_stdout(cmd_stack, tmp_modules_dir)
        priorities = [m["priority"] for m in result["active"]]
        assert priorities == sorted(priorities, reverse=True)


class TestCmdInfo:
    def test_shows_module_info(self, tmp_modules_dir):
        result = _capture_stdout(cmd_info, tmp_modules_dir, {"module_id": "react-native-dev"})
        assert result["id"] == "react-native-dev"
        assert result["manifest"]["name"] == "React Native Development"
        assert result["registry"]["status"] == "active"
        assert result["patternsLines"] > 0

    def test_nonexistent_module(self, tmp_modules_dir):
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_info, tmp_modules_dir, {"module_id": "nonexistent"})
