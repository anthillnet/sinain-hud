#!/usr/bin/env python3
"""Tier 1 Evaluation: Per-tick evaluator — runs as independent server cron job.

Reads playbook-logs written by the heartbeat, validates outputs against
JSON schemas, runs behavioral assertions, and optionally invokes LLM-as-Judge
evaluators.  Writes results to memory/eval-logs/YYYY-MM-DD.jsonl.

Invocation (cron, every 30 min offset from heartbeat):
    uv run --with requests python3 sinain-koog/tick_evaluator.py \
        --memory-dir memory/

Config-driven eval levels:
    mechanical — schema + assertions only (zero LLM cost)
    sampled    — mechanical + random LLM judges at sampleRate probability
    full       — mechanical + LLM judges on every tick output
"""

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure sinain-koog is on sys.path for imports
_koog_dir = str(Path(__file__).resolve().parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from common import (
    _load_config,
    _read_jsonl,
    list_daily_memory_files,
    read_playbook,
)
from eval.assertions import run_tick_assertions
from eval.schemas import SCHEMA_REGISTRY, validate


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_EVAL_DEFAULTS = {
    "level": "mechanical",
    "sampleRate": 0.2,
    "judges": {"model": "smart", "maxTokens": 200, "timeout": 30},
    "dailyReport": True,
    "regressionThresholds": {
        "assertionPassRate": 0.85,
        "effectivenessRate": 0.4,
        "skipRate": 0.8,
    },
}


def load_eval_config(memory_dir: str) -> dict:
    """Load eval config with runtime overrides from memory/eval-config.json."""
    base = _load_config().get("eval", {})
    cfg = {**_EVAL_DEFAULTS, **base}

    override_path = Path(memory_dir) / "eval-config.json"
    if override_path.exists():
        try:
            override = json.loads(override_path.read_text(encoding="utf-8"))
            cfg.update(override)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[warn] eval-config.json override failed: {e}", file=sys.stderr)

    return cfg


# ---------------------------------------------------------------------------
# Log readers
# ---------------------------------------------------------------------------

def read_today_playbook_logs(memory_dir: str) -> list[dict]:
    """Read today's playbook-log entries."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = Path(memory_dir) / "playbook-logs" / f"{today}.jsonl"
    return _read_jsonl(log_file)


def read_today_eval_logs(memory_dir: str) -> list[dict]:
    """Read today's eval-log entries to find already-evaluated ticks."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = Path(memory_dir) / "eval-logs" / f"{today}.jsonl"
    return _read_jsonl(log_file)


def get_evaluated_timestamps(eval_logs: list[dict]) -> set[str]:
    """Extract the set of tick timestamps that have already been evaluated."""
    return {e.get("tickTs", "") for e in eval_logs if e.get("tickTs")}


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

def validate_tick_schemas(log_entry: dict) -> dict:
    """Validate script outputs reconstructed from a heartbeat log entry.

    The heartbeat flattens/reshapes script outputs when writing to the JSONL log.
    This function reconstructs the original script output shapes from log fields
    and validates them against the canonical schemas.

    Returns {"total": int, "valid": int, "failures": [{"script": str, "errors": [...]}]}.
    """
    total = 0
    valid = 0
    failures: list[dict] = []

    def _check(script_name: str, data: dict) -> None:
        nonlocal total, valid
        schema = SCHEMA_REGISTRY.get(script_name)
        if schema is None:
            return
        total += 1
        errors = validate(data, schema)
        if errors:
            failures.append({"script": script_name, "errors": errors})
        else:
            valid += 1

    # --- Signal Analyzer ---
    # Log stores: signals (list), recommendedAction (obj|null), idle (bool)
    if "signals" in log_entry:
        _check("signal_analyzer", {
            "signals": log_entry.get("signals", []),
            "recommendedAction": log_entry.get("recommendedAction"),
            "idle": log_entry.get("idle", False),
        })

    # --- Feedback Analyzer ---
    # Log stores: feedbackScores ({avg}), effectivenessRate (float),
    # curateDirective (str).  The full effectiveness dict is NOT in the log —
    # the heartbeat only writes effectivenessRate.  Reconstruct a minimal valid
    # shape; skip required-field checks we know the log doesn't carry.
    if "feedbackScores" in log_entry and "curateDirective" in log_entry:
        eff_rate = log_entry.get("effectivenessRate", 0)
        _check("feedback_analyzer", {
            "feedbackScores": log_entry.get("feedbackScores", {}),
            "effectiveness": {
                "outputs": 0, "positive": 0, "negative": 0, "neutral": 0,
                "rate": eff_rate if isinstance(eff_rate, (int, float)) else 0,
            },
            "curateDirective": log_entry.get("curateDirective", "normal"),
            "interpretation": log_entry.get("interpretation", ""),
        })

    # --- Memory Miner ---
    # Log stores: miningFindings (str|null), minedSources (list)
    if log_entry.get("miningFindings") is not None:
        _check("memory_miner", {
            "findings": log_entry.get("miningFindings", ""),
            "newPatterns": log_entry.get("newPatterns", []),
            "minedSources": log_entry.get("minedSources", []),
        })

    # --- Playbook Curator ---
    # Log stores: playbookChanges (dict) — can be {"note": "skipped"} or full
    # curator output with changes.added/pruned/promoted and playbookLines.
    pc = log_entry.get("playbookChanges")
    if isinstance(pc, dict) and "changes" in pc:
        _check("playbook_curator", pc)

    # --- Insight Synthesizer ---
    # Log stores: output (dict|null).  When null, the synthesizer was skipped
    # at the pipeline level (before it ran), which is different from skip=true.
    output = log_entry.get("output")
    if isinstance(output, dict):
        _check("insight_synthesizer", output)

    return {"total": total, "valid": valid, "failures": failures}


# ---------------------------------------------------------------------------
# LLM judge runner
# ---------------------------------------------------------------------------

def run_judges(log_entry: dict, playbook_text: str, eval_config: dict) -> dict | None:
    """Run LLM-as-Judge evaluators on a tick's outputs.

    Returns dict of judge results, or None if judges are not applicable.
    """
    # Late import to avoid loading LLM deps in mechanical mode
    from eval.judges.signal_judge import judge_signal
    from eval.judges.curation_judge import judge_curation
    from eval.judges.insight_judge import judge_insight
    from eval.judges.mining_judge import judge_mining

    judge_cfg = eval_config.get("judges", {})
    kwargs = {}
    if judge_cfg.get("model"):
        # Model will be resolved by common.call_llm via script config
        pass
    if judge_cfg.get("maxTokens"):
        kwargs["max_tokens"] = judge_cfg["maxTokens"]

    results: dict = {}

    # Signal judge
    signals = log_entry.get("signals")
    if signals is not None:
        signal_data = {
            "signals": signals,
            "recommendedAction": log_entry.get("recommendedAction"),
            "idle": log_entry.get("idle", False),
        }
        session_summary = log_entry.get("sessionSummary", "")
        result = judge_signal(signal_data, session_summary, **kwargs)
        if result:
            results["signal"] = result

    # Curation judge
    curator = log_entry.get("playbookChanges")
    if curator is not None:
        directive = log_entry.get("curateDirective", "normal")
        result = judge_curation(curator, directive, playbook_text, **kwargs)
        if result:
            results["curation"] = result

    # Insight judge
    output = log_entry.get("output")
    if output is not None:
        result = judge_insight(output, playbook_text[:1000] if playbook_text else "", **kwargs)
        if result:
            results["insight"] = result

    # Mining judge
    mining = log_entry.get("miningResult")
    if mining is not None:
        result = judge_mining(mining, **kwargs)
        if result:
            results["mining"] = result

    return results if results else None


# ---------------------------------------------------------------------------
# Main evaluation loop
# ---------------------------------------------------------------------------

def evaluate_tick(
    log_entry: dict,
    recent_logs: list[dict],
    playbook_text: str,
    daily_files: list[str],
    eval_config: dict,
) -> dict:
    """Evaluate a single tick's log entry.

    Returns the eval result dict to be written to eval-logs.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tick_ts = log_entry.get("ts", "unknown")
    level = eval_config.get("level", "mechanical")

    # 1. Schema validation
    schema_result = validate_tick_schemas(log_entry)

    # 2. Behavioral assertions
    assertion_results = run_tick_assertions(log_entry, recent_logs, playbook_text, daily_files)
    passed = sum(1 for a in assertion_results if a["passed"])
    assertion_failures = [a for a in assertion_results if not a["passed"]]

    # 3. LLM judges (if level warrants it)
    judges = None
    if level == "full":
        judges = run_judges(log_entry, playbook_text, eval_config)
    elif level == "sampled":
        sample_rate = eval_config.get("sampleRate", 0.2)
        if random.random() < sample_rate:
            judges = run_judges(log_entry, playbook_text, eval_config)

    # 4. Compute pass rate
    total_checks = schema_result["total"] + len(assertion_results)
    passed_checks = schema_result["valid"] + passed
    pass_rate = round(passed_checks / total_checks, 3) if total_checks > 0 else 1.0

    result = {
        "ts": now,
        "tickTs": tick_ts,
        "evalLevel": level,
        "schema": {
            "total": schema_result["total"],
            "valid": schema_result["valid"],
            "failures": schema_result["failures"],
        },
        "assertions": {
            "total": len(assertion_results),
            "passed": passed,
            "failures": [{"name": a["name"], "detail": a["detail"]} for a in assertion_failures],
        },
        "judges": judges,
        "passRate": pass_rate,
    }

    # Add judge average if available
    if judges:
        scores = [v["score"] for v in judges.values() if isinstance(v, dict) and "score" in v]
        if scores:
            result["judgeAvg"] = round(sum(scores) / len(scores), 2)

    return result


def main():
    parser = argparse.ArgumentParser(description="Sinain Koog Tick Evaluator (Tier 1)")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    eval_config = load_eval_config(memory_dir)

    print(f"[tick-eval] level={eval_config.get('level')} sampleRate={eval_config.get('sampleRate')}",
          file=sys.stderr)

    # Read today's logs
    playbook_logs = read_today_playbook_logs(memory_dir)
    if not playbook_logs:
        print("[tick-eval] no playbook-log entries for today", file=sys.stderr)
        return

    # Find unevaluated ticks
    eval_logs = read_today_eval_logs(memory_dir)
    evaluated_ts = get_evaluated_timestamps(eval_logs)
    unevaluated = [e for e in playbook_logs if e.get("ts", "") not in evaluated_ts]

    if not unevaluated:
        print("[tick-eval] all ticks already evaluated", file=sys.stderr)
        return

    print(f"[tick-eval] {len(unevaluated)} unevaluated ticks found", file=sys.stderr)

    # Shared context
    playbook_text = read_playbook(memory_dir)
    daily_files = [Path(f).name for f in list_daily_memory_files(memory_dir)]

    # Evaluate each unevaluated tick
    eval_log_dir = Path(memory_dir) / "eval-logs"
    eval_log_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    eval_log_file = eval_log_dir / f"{today}.jsonl"

    attempted = 0
    succeeded = 0
    failed = 0
    fail_ticks: list[str] = []

    for entry in unevaluated:
        tick_ts = entry.get("ts", "")
        attempted += 1

        try:
            # Recent logs for assertion context (logs before this tick)
            recent = [e for e in playbook_logs if e.get("ts", "") < tick_ts]

            result = evaluate_tick(entry, recent, playbook_text, daily_files, eval_config)

            with open(eval_log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
            succeeded += 1

            status = "PASS" if result["passRate"] >= 0.85 else "WARN"
            judge_info = f" judgeAvg={result.get('judgeAvg', '-')}" if result.get("judges") else ""
            print(f"[tick-eval] {status} tick={tick_ts} passRate={result['passRate']}{judge_info}",
                  file=sys.stderr)
        except Exception as exc:
            failed += 1
            fail_ticks.append(tick_ts)
            print(f"[tick-eval] ERROR tick={tick_ts}: {exc}", file=sys.stderr)

    # Write run summary so the reporter can detect partial runs
    run_summary = {
        "_type": "run_summary",
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "attempted": attempted,
        "succeeded": succeeded,
        "failed": failed,
        "isPartial": failed > 0,
        "failedTicks": fail_ticks,
    }
    with open(eval_log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(run_summary, ensure_ascii=False) + "\n")

    print(f"[tick-eval] wrote {succeeded} eval entries to {eval_log_file} "
          f"(attempted={attempted}, failed={failed})", file=sys.stderr)


if __name__ == "__main__":
    main()
