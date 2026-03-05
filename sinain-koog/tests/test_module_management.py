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
    cmd_guidance,
    cmd_export,
    cmd_import,
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
        assert result["guidanceChars"] == 0

    def test_info_with_guidance(self, tmp_modules_dir):
        guidance = "When user asks about hot reload, suggest Hermes bytecode caching"
        (tmp_modules_dir / "react-native-dev" / "guidance.md").write_text(guidance, encoding="utf-8")
        result = _capture_stdout(cmd_info, tmp_modules_dir, {"module_id": "react-native-dev"})
        assert result["guidanceChars"] == len(guidance)

    def test_nonexistent_module(self, tmp_modules_dir):
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_info, tmp_modules_dir, {"module_id": "nonexistent"})


class TestCmdGuidance:
    def test_view_empty_guidance(self, tmp_modules_dir):
        result = _capture_stdout(cmd_guidance, tmp_modules_dir, {
            "module_id": "react-native-dev", "set": None, "clear": False,
        })
        assert result["module"] == "react-native-dev"
        assert result["hasGuidance"] is False
        assert result["guidance"] == ""

    def test_set_guidance(self, tmp_modules_dir):
        text = "When user asks about hot reload, suggest Hermes bytecode caching"
        result = _capture_stdout(cmd_guidance, tmp_modules_dir, {
            "module_id": "react-native-dev", "set": text, "clear": False,
        })
        assert result["written"] is True
        assert result["guidanceChars"] == len(text)
        # Verify file on disk
        guidance_path = tmp_modules_dir / "react-native-dev" / "guidance.md"
        assert guidance_path.read_text(encoding="utf-8") == text

    def test_view_existing_guidance(self, tmp_modules_dir):
        text = "Proactively suggest frame batching for OCR"
        (tmp_modules_dir / "react-native-dev" / "guidance.md").write_text(text, encoding="utf-8")
        result = _capture_stdout(cmd_guidance, tmp_modules_dir, {
            "module_id": "react-native-dev", "set": None, "clear": False,
        })
        assert result["hasGuidance"] is True
        assert result["guidance"] == text

    def test_clear_guidance(self, tmp_modules_dir):
        (tmp_modules_dir / "react-native-dev" / "guidance.md").write_text("some guidance", encoding="utf-8")
        result = _capture_stdout(cmd_guidance, tmp_modules_dir, {
            "module_id": "react-native-dev", "set": None, "clear": True,
        })
        assert result["cleared"] is True
        assert not (tmp_modules_dir / "react-native-dev" / "guidance.md").exists()

    def test_nonexistent_module(self, tmp_modules_dir):
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_guidance, tmp_modules_dir, {
                "module_id": "nonexistent", "set": None, "clear": False,
            })


class TestCmdExport:
    def test_export_produces_valid_bundle(self, tmp_modules_dir, tmp_path):
        output = tmp_path / "export.sinain-module.json"
        result = _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": str(output),
        })
        assert result["exported"] == "react-native-dev"
        assert output.exists()

        bundle = json.loads(output.read_text(encoding="utf-8"))
        assert bundle["format"] == "sinain-module-v1"
        assert bundle["moduleId"] == "react-native-dev"
        assert "exportedAt" in bundle
        assert bundle["manifest"]["name"] == "React Native Development"
        assert "Hermes" in bundle["patterns"]

    def test_export_includes_context_files(self, tmp_modules_dir, tmp_path):
        # Add a context file
        ctx_dir = tmp_modules_dir / "react-native-dev" / "context"
        ctx_dir.mkdir()
        (ctx_dir / "notes.json").write_text('{"key": "value"}', encoding="utf-8")

        output = tmp_path / "export.sinain-module.json"
        _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": str(output),
        })
        bundle = json.loads(output.read_text(encoding="utf-8"))
        assert "notes.json" in bundle["context"]
        assert bundle["context"]["notes.json"] == '{"key": "value"}'

    def test_export_default_output_path(self, tmp_modules_dir):
        result = _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": None,
        })
        default_path = Path("react-native-dev.sinain-module.json")
        assert result["outputPath"] == str(default_path)
        # Clean up
        if default_path.exists():
            default_path.unlink()

    def test_export_includes_guidance(self, tmp_modules_dir, tmp_path):
        guidance = "Suggest Hermes bytecode caching for hot reload"
        (tmp_modules_dir / "react-native-dev" / "guidance.md").write_text(guidance, encoding="utf-8")
        output = tmp_path / "export.sinain-module.json"
        result = _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": str(output),
        })
        assert result["guidanceChars"] == len(guidance)
        bundle = json.loads(output.read_text(encoding="utf-8"))
        assert bundle["guidance"] == guidance

    def test_export_no_guidance(self, tmp_modules_dir, tmp_path):
        output = tmp_path / "export.sinain-module.json"
        _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": str(output),
        })
        bundle = json.loads(output.read_text(encoding="utf-8"))
        assert bundle["guidance"] == ""

    def test_export_nonexistent_module(self, tmp_modules_dir):
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_export, tmp_modules_dir, {
                "module_id": "nonexistent",
                "output": None,
            })


class TestCmdImport:
    def _make_bundle(self, tmp_path, module_id="test-module", patterns="# Test\n- pattern 1\n",
                     guidance="", context=None, manifest_extra=None):
        """Helper to create a valid bundle file."""
        manifest = {
            "id": module_id,
            "name": "Test Module",
            "version": "1.0.0",
            "priority": {"default": 75, "range": [50, 100]},
            "locked": False,
        }
        if manifest_extra:
            manifest.update(manifest_extra)
        bundle = {
            "format": "sinain-module-v1",
            "moduleId": module_id,
            "exportedAt": "2026-03-05T12:00:00Z",
            "manifest": manifest,
            "patterns": patterns,
            "guidance": guidance,
            "context": context or {},
        }
        path = tmp_path / f"{module_id}.sinain-module.json"
        path.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
        return path

    def test_import_creates_module(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(tmp_path)
        result = _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": False,
        })
        assert result["imported"] == "test-module"
        assert result["status"] == "suspended"

        # Check files created
        module_dir = tmp_modules_dir / "test-module"
        assert (module_dir / "manifest.json").exists()
        assert (module_dir / "patterns.md").exists()

        manifest = json.loads((module_dir / "manifest.json").read_text(encoding="utf-8"))
        assert "importedAt" in manifest
        assert manifest["source"] == "module_manager import"

    def test_import_registers_as_suspended(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(tmp_path)
        _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": False,
        })
        reg = _load_registry(tmp_modules_dir)
        assert reg["modules"]["test-module"]["status"] == "suspended"
        assert reg["modules"]["test-module"]["activatedAt"] is None

    def test_import_with_activate(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(tmp_path)
        result = _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": True,
            "force": False,
        })
        assert result["status"] == "active"

        reg = _load_registry(tmp_modules_dir)
        assert reg["modules"]["test-module"]["status"] == "active"
        assert reg["modules"]["test-module"]["activatedAt"] is not None

    def test_import_with_context_files(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(tmp_path, context={"config.json": '{"x": 1}'})
        _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": False,
        })
        ctx_file = tmp_modules_dir / "test-module" / "context" / "config.json"
        assert ctx_file.exists()
        assert ctx_file.read_text(encoding="utf-8") == '{"x": 1}'

    def test_import_with_guidance(self, tmp_modules_dir, tmp_path):
        guidance = "- Suggest frame batching for OCR\n- Prefer concise responses"
        bundle_path = self._make_bundle(tmp_path, guidance=guidance)
        _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": False,
        })
        guidance_file = tmp_modules_dir / "test-module" / "guidance.md"
        assert guidance_file.exists()
        assert guidance_file.read_text(encoding="utf-8") == guidance

    def test_import_without_guidance(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(tmp_path, guidance="")
        _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": False,
        })
        assert not (tmp_modules_dir / "test-module" / "guidance.md").exists()

    def test_import_existing_module_fails_without_force(self, tmp_modules_dir, tmp_path):
        # react-native-dev already exists in tmp_modules_dir
        bundle_path = self._make_bundle(tmp_path, module_id="react-native-dev")
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_import, tmp_modules_dir, {
                "bundle": str(bundle_path),
                "activate": False,
                "force": False,
            })

    def test_import_with_force_overwrites(self, tmp_modules_dir, tmp_path):
        bundle_path = self._make_bundle(
            tmp_path, module_id="react-native-dev",
            patterns="# Overwritten\n- new pattern\n",
        )
        result = _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(bundle_path),
            "activate": False,
            "force": True,
        })
        assert result["imported"] == "react-native-dev"

        patterns = (tmp_modules_dir / "react-native-dev" / "patterns.md").read_text(encoding="utf-8")
        assert "Overwritten" in patterns

    def test_import_invalid_format_fails(self, tmp_modules_dir, tmp_path):
        bad_bundle = tmp_path / "bad.sinain-module.json"
        bad_bundle.write_text(json.dumps({"format": "unknown-v99"}), encoding="utf-8")
        with pytest.raises(SystemExit):
            _capture_stdout(cmd_import, tmp_modules_dir, {
                "bundle": str(bad_bundle),
                "activate": False,
                "force": False,
            })

    def test_roundtrip_export_import(self, tmp_modules_dir, tmp_path):
        """Export a module, import into same instance under new name, verify match."""
        # Add guidance before export
        guidance = "- Suggest Hermes bytecode caching\n- Recommend flipper for debugging"
        (tmp_modules_dir / "react-native-dev" / "guidance.md").write_text(guidance, encoding="utf-8")

        # Export existing module
        export_path = tmp_path / "exported.sinain-module.json"
        _capture_stdout(cmd_export, tmp_modules_dir, {
            "module_id": "react-native-dev",
            "output": str(export_path),
        })

        # Modify bundle to use different module ID (simulates transfer)
        bundle = json.loads(export_path.read_text(encoding="utf-8"))
        bundle["moduleId"] = "rn-dev-copy"
        bundle["manifest"]["id"] = "rn-dev-copy"
        modified_path = tmp_path / "modified.sinain-module.json"
        modified_path.write_text(json.dumps(bundle), encoding="utf-8")

        # Import
        result = _capture_stdout(cmd_import, tmp_modules_dir, {
            "bundle": str(modified_path),
            "activate": True,
            "force": False,
        })
        assert result["imported"] == "rn-dev-copy"

        # Verify patterns match original
        original = (tmp_modules_dir / "react-native-dev" / "patterns.md").read_text(encoding="utf-8")
        copied = (tmp_modules_dir / "rn-dev-copy" / "patterns.md").read_text(encoding="utf-8")
        assert original == copied

        # Verify guidance survives roundtrip
        copied_guidance = (tmp_modules_dir / "rn-dev-copy" / "guidance.md").read_text(encoding="utf-8")
        assert copied_guidance == guidance

        # Verify manifest has import metadata
        manifest = json.loads((tmp_modules_dir / "rn-dev-copy" / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["importedAt"] is not None
        assert manifest["name"] == "React Native Development"
