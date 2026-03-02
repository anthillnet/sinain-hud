#!/usr/bin/env python3
"""Local integration test for sinain-koog heartbeat scripts.

Runs all scripts in pipeline order using real memory/ data (or synthetic data
if memory/ is sparse). Requires OPENROUTER_API_KEY env var.

Usage:
    OPENROUTER_API_KEY=... python3 sinain-koog/test_local.py [--memory-dir memory/]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SESSION_SUMMARY = "User worked on sinain-hud wearable camera pipeline. Debugged OCR backpressure issues. Explored Flutter overlay options for macOS."


def run_script(name: str, args: list[str], label: str) -> dict | None:
    """Run a Python script, capture stdout JSON and stderr logs."""
    cmd = [sys.executable, str(SCRIPT_DIR / name)] + args
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"  cmd: {' '.join(cmd)}")
    print(f"{'='*60}")

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    if result.stderr:
        for line in result.stderr.strip().splitlines():
            print(f"  stderr: {line}")

    if result.returncode != 0:
        print(f"  EXIT CODE: {result.returncode}")
        print(f"  stdout: {result.stdout[:500]}")
        return None

    stdout = result.stdout.strip()
    if not stdout:
        print("  (no stdout)")
        return None

    try:
        data = json.loads(stdout)
        print(f"  OUTPUT: {json.dumps(data, indent=2)[:1000]}")
        return data
    except json.JSONDecodeError:
        print(f"  RAW OUTPUT: {stdout[:500]}")
        return None


def setup_synthetic_memory(memory_dir: str) -> None:
    """Create minimal synthetic memory data for testing."""
    md = Path(memory_dir)
    md.mkdir(parents=True, exist_ok=True)
    (md / "playbook-logs").mkdir(exist_ok=True)
    (md / "playbook-archive").mkdir(exist_ok=True)

    # Create playbook if missing
    playbook_path = md / "sinain-playbook.md"
    if not playbook_path.exists():
        playbook_path.write_text(
            "<!-- mining-index: -->\n"
            "# Sinain Playbook\n\n"
            "## Established Patterns\n"
            '- When OCR pipeline stalls, check camera frame queue depth (score: 0.8)\n'
            '- When user explores new framework, spawn research agent proactively (score: 0.6)\n\n'
            "## Observed\n"
            '- User prefers concise Telegram messages over detailed ones\n'
            '- Late evening sessions tend to be exploratory/research-heavy\n\n'
            "## Stale\n"
            '- Flutter overlay rendering glitch on macOS 15 [since: 2026-02-18]\n\n'
            "<!-- effectiveness: outputs=8, positive=5, negative=1, neutral=2, rate=0.63, updated=2026-02-21 -->\n",
            encoding="utf-8",
        )

    # Create a sample daily memory file
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily_path = md / f"{today}.md"
    if not daily_path.exists():
        daily_path.write_text(
            f"# {today} Session Notes\n\n"
            "## OCR Pipeline\n"
            "- Switched from Tesseract to OpenRouter vision API\n"
            "- Backpressure issue: camera produces frames faster than API can process\n"
            "- Solution: frame dropping with scene-gate (skip similar consecutive frames)\n\n"
            "## Wearable HUD\n"
            "- Testing 3-panel debug interface\n"
            "- Camera feed, OCR overlay, and pipeline stats side-by-side\n"
            "- Found that JPEG quality 70 is good balance of speed vs readability\n",
            encoding="utf-8",
        )

    # Create a sample log entry
    log_path = md / "playbook-logs" / f"{today}.jsonl"
    if not log_path.exists():
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "idle": False,
            "sessionHistorySummary": "User debugging OCR pipeline",
            "feedbackScores": {"avg": 0.35, "high": ["OCR fix suggestion"], "low": []},
            "actionsConsidered": [
                {"action": "spawn research", "reason": "Flutter overlay perf", "chosen": False, "skipReason": "not urgent"}
            ],
            "effectivenessRate": 0.63,
            "effectivenessAlert": False,
            "playbookChanges": {"added": [], "pruned": [], "promoted": []},
            "output": {"suggestion": "Consider frame batching for OCR pipeline", "insight": "Evening sessions correlate with exploratory work"},
            "skipped": False,
        }
        log_path.write_text(json.dumps(entry) + "\n", encoding="utf-8")


def test_extract_json():
    """Unit tests for extract_json() — validates all three extraction stages."""
    # Import here so the test file can still run standalone
    sys.path.insert(0, str(SCRIPT_DIR))
    from common import extract_json

    passed = 0
    failed = 0

    def check(label: str, input_text: str, expected_key: str | None = None, expect_fail: bool = False):
        nonlocal passed, failed
        try:
            result = extract_json(input_text)
            if expect_fail:
                print(f"  FAIL: {label} — expected ValueError but got: {result}")
                failed += 1
                return
            if expected_key and expected_key not in result:
                print(f"  FAIL: {label} — missing key '{expected_key}' in {result}")
                failed += 1
                return
            print(f"  OK:   {label}")
            passed += 1
        except ValueError:
            if expect_fail:
                print(f"  OK:   {label} (correctly raised ValueError)")
                passed += 1
            else:
                print(f"  FAIL: {label} — unexpected ValueError")
                failed += 1

    print(f"\n{'='*60}")
    print("  Unit Tests: extract_json()")
    print(f"{'='*60}")

    # Stage 1: clean JSON
    check("clean object", '{"signals": [], "idle": true}', "signals")
    check("clean array", '[{"a": 1}, {"b": 2}]')

    # Stage 2: markdown fences
    check("fenced json", '```json\n{"signals": ["x"], "idle": false}\n```', "signals")
    check("fenced no lang tag", '```\n{"findings": "test"}\n```', "findings")
    check("text before fence", 'Here is the result:\n```json\n{"skip": true}\n```', "skip")
    check("text after fence", '```json\n{"skip": false}\n```\nHope this helps!', "skip")
    check("text before and after fence",
          'I analyzed it.\n```json\n{"curateDirective": "normal"}\n```\nLet me know.',
          "curateDirective")

    # Stage 3: balanced-brace scanner (prose-embedded JSON)
    check("prose then JSON", 'The analysis result is: {"signals": ["a"], "idle": true}', "signals")
    check("JSON then prose", '{"findings": "test"} That is all.', "findings")
    check("nested braces", '{"outer": {"inner": {"deep": 1}}, "key": "val"}', "outer")
    check("strings with braces",
          '{"msg": "use {braces} like this", "ok": true}', "msg")
    check("prose-embedded array", 'Result: [{"a": 1}, {"b": 2}]')

    # Edge cases
    check("whitespace padded", '  \n  {"key": "value"}  \n  ', "key")
    check("no JSON at all", "This is just plain text with no JSON.", expect_fail=True)
    check("empty string", "", expect_fail=True)
    # Stage 4: truncated JSON repair
    check("truncated object — missing closing brace",
          '{"signals": ["a", "b"], "idle": true, "extra": "val',
          "signals")
    check("truncated nested — missing two closing braces",
          '{"outer": {"inner": "val"',
          "outer")
    check("truncated array in object",
          '{"items": [1, 2, 3',
          "items")
    check("truncated with trailing comma",
          '{"a": 1, "b": 2,',
          "a")
    check("truncated mid-key (Strategy C strips back)", '{"valid": 1, "partial_ke', "valid")
    check("prose + truncated JSON",
          'Here is the result: {"findings": "some text", "patterns": ["p1"',
          "findings")

    # Previously malformed — Stage 4 can now repair this (unclosed string + brace)
    check("truncated simple object", '{"unclosed": "brace"', "unclosed")

    # Truly unrecoverable
    check("no JSON at all v2", "just some random text without any brackets", expect_fail=True)

    print(f"\n  Results: {passed} passed, {failed} failed")
    if failed > 0:
        print("  SOME TESTS FAILED")
        return False
    print("  All tests passed!")
    return True


def test_llm_error():
    """Unit tests for LLMError — verifies call_llm raises LLMError on request failures."""
    from unittest.mock import patch, MagicMock
    sys.path.insert(0, str(SCRIPT_DIR))
    from common import call_llm, LLMError

    passed = 0
    failed = 0

    print(f"\n{'='*60}")
    print("  Unit Tests: LLMError from call_llm()")
    print(f"{'='*60}")

    # Test 1: Timeout raises LLMError
    import requests as req_mod
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        with patch("common.requests.post", side_effect=req_mod.exceptions.Timeout("Connection timed out")):
            try:
                call_llm("system", "user")
                print("  FAIL: timeout — expected LLMError but call succeeded")
                failed += 1
            except LLMError as e:
                if "Timeout" in str(e):
                    print("  OK:   timeout raises LLMError with Timeout info")
                    passed += 1
                else:
                    print(f"  FAIL: timeout — LLMError message missing 'Timeout': {e}")
                    failed += 1
            except Exception as e:
                print(f"  FAIL: timeout — expected LLMError but got {type(e).__name__}: {e}")
                failed += 1

    # Test 2: ConnectionError raises LLMError
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        with patch("common.requests.post", side_effect=req_mod.exceptions.ConnectionError("DNS failed")):
            try:
                call_llm("system", "user")
                print("  FAIL: connection error — expected LLMError")
                failed += 1
            except LLMError as e:
                if "ConnectionError" in str(e):
                    print("  OK:   ConnectionError raises LLMError")
                    passed += 1
                else:
                    print(f"  FAIL: connection error — message missing type: {e}")
                    failed += 1
            except Exception as e:
                print(f"  FAIL: connection error — got {type(e).__name__}: {e}")
                failed += 1

    # Test 3: HTTP 500 raises LLMError
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = req_mod.exceptions.HTTPError("500 Server Error")
        with patch("common.requests.post", return_value=mock_resp):
            try:
                call_llm("system", "user")
                print("  FAIL: HTTP 500 — expected LLMError")
                failed += 1
            except LLMError as e:
                if "HTTPError" in str(e):
                    print("  OK:   HTTP 500 raises LLMError")
                    passed += 1
                else:
                    print(f"  FAIL: HTTP 500 — message missing type: {e}")
                    failed += 1
            except Exception as e:
                print(f"  FAIL: HTTP 500 — got {type(e).__name__}: {e}")
                failed += 1

    print(f"\n  Results: {passed} passed, {failed} failed")
    if failed > 0:
        print("  SOME TESTS FAILED")
        return False
    print("  All tests passed!")
    return True


def main():
    parser = argparse.ArgumentParser(description="sinain-koog integration test")
    parser.add_argument("--memory-dir", default="memory/", help="Path to memory/ directory")
    parser.add_argument("--use-synthetic", action="store_true", help="Create synthetic test data")
    args = parser.parse_args()

    # Run unit tests first (no API key needed)
    if not test_extract_json():
        sys.exit(1)
    if not test_llm_error():
        sys.exit(1)

    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")):
        print("ERROR: OPENROUTER_API_KEY or OPENROUTER_API_KEY_REFLECTION env var is required")
        sys.exit(1)

    memory_dir = args.memory_dir
    cleanup_synthetic = False

    # If no real memory data, use synthetic
    if args.use_synthetic or not Path(memory_dir, "sinain-playbook.md").exists():
        if args.use_synthetic:
            print("Using synthetic memory data...")
        else:
            print(f"No playbook found at {memory_dir}/sinain-playbook.md — using synthetic data")
        if not args.use_synthetic:
            memory_dir = tempfile.mkdtemp(prefix="sinain-test-memory-")
            cleanup_synthetic = True
        setup_synthetic_memory(memory_dir)

    print(f"Memory dir: {memory_dir}")
    print(f"Session summary: {SESSION_SUMMARY[:80]}...")

    results = {}
    failed = False

    # Phase 2: Signal Analyzer
    r = run_script("signal_analyzer.py", [
        "--memory-dir", memory_dir,
        "--session-summary", SESSION_SUMMARY,
    ], "Phase 2: Signal Analyzer")
    results["signal_analyzer"] = r
    if r is None:
        failed = True

    # Phase 3.1: Memory Miner (idle only — run it for testing)
    r = run_script("memory_miner.py", [
        "--memory-dir", memory_dir,
    ], "Phase 3.1: Memory Miner (idle)")
    results["memory_miner"] = r
    mining_findings = ""
    if r:
        mining_findings = r.get("findings", "")

    # Phase 3.2: Feedback Analyzer
    r = run_script("feedback_analyzer.py", [
        "--memory-dir", memory_dir,
        "--session-summary", SESSION_SUMMARY,
    ], "Phase 3.2: Feedback Analyzer")
    results["feedback_analyzer"] = r
    curate_directive = "normal"
    if r:
        curate_directive = r.get("curateDirective", "normal")

    # Phase 3.3: Playbook Curator
    curator_args = [
        "--memory-dir", memory_dir,
        "--session-summary", SESSION_SUMMARY,
        "--curate-directive", curate_directive,
    ]
    if mining_findings:
        curator_args += ["--mining-findings", mining_findings]
    r = run_script("playbook_curator.py", curator_args, "Phase 3.3: Playbook Curator")
    results["playbook_curator"] = r
    curator_changes = ""
    if r:
        curator_changes = json.dumps(r.get("changes", {}))

    # Phase 3.4: JSONL log — skipped (main agent responsibility)
    print(f"\n{'='*60}")
    print("  Phase 3.4: JSONL Log (SKIPPED — main agent responsibility)")
    print(f"{'='*60}")

    # Phase 3.5: Insight Synthesizer
    synth_args = [
        "--memory-dir", memory_dir,
        "--session-summary", SESSION_SUMMARY,
    ]
    if curator_changes:
        synth_args += ["--curator-changes", curator_changes]
    r = run_script("insight_synthesizer.py", synth_args, "Phase 3.5: Insight Synthesizer")
    results["insight_synthesizer"] = r

    # Summary
    print(f"\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    for name, data in results.items():
        status = "OK" if data is not None else "FAILED"
        print(f"  {name}: {status}")

    if failed:
        print("\nSome scripts failed — check output above.")
        sys.exit(1)
    else:
        print("\nAll scripts completed successfully!")

    if cleanup_synthetic:
        shutil.rmtree(memory_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
