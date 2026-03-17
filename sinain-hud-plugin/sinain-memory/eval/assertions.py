"""Behavioral assertion library for sinain-koog tick evaluation.

Each assertion function validates a runtime invariant of the pipeline.
Returns ``{"name": str, "passed": bool, "detail": str}``.
"""

from __future__ import annotations


def _result(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}


# ---------------------------------------------------------------------------
# Playbook curator assertions
# ---------------------------------------------------------------------------

def assert_playbook_under_limit(curator_result: dict, limit: int = 50) -> dict:
    """Verify playbook body stays under the line limit."""
    lines = curator_result.get("playbookLines", 0)
    if lines <= limit:
        return _result("playbook_under_limit", True, f"body has {lines} lines (limit {limit})")
    return _result("playbook_under_limit", False, f"body has {lines} lines, exceeds limit of {limit}")


def assert_curator_respected_directive(curator_result: dict, directive: str) -> dict:
    """Check that curator changes align with the curate directive."""
    changes = curator_result.get("changes", {})
    added = len(changes.get("added", []))
    pruned = len(changes.get("pruned", []))

    if directive == "aggressive_prune":
        # Should have pruned items
        if pruned > 0:
            return _result("curator_respected_directive", True,
                           f"aggressive_prune: pruned {pruned} items")
        if added == 0 and pruned == 0:
            return _result("curator_respected_directive", True,
                           "aggressive_prune: no changes (acceptable if playbook already lean)")
        return _result("curator_respected_directive", False,
                       f"aggressive_prune: added {added} but pruned {pruned} — expected pruning")

    if directive == "stability":
        # Should not aggressively prune established patterns
        if pruned > added + 2:
            return _result("curator_respected_directive", False,
                           f"stability: pruned {pruned} items (only added {added}) — too aggressive for stability mode")
        return _result("curator_respected_directive", True,
                       f"stability: added {added}, pruned {pruned} — conservative")

    # normal / insufficient_data — any reasonable mix is fine
    return _result("curator_respected_directive", True,
                   f"{directive}: added {added}, pruned {pruned}")


# ---------------------------------------------------------------------------
# Signal analyzer assertions
# ---------------------------------------------------------------------------

def assert_no_repeat_action(signal_result: dict, recent_logs: list[dict], window: int = 3) -> dict:
    """Verify recommendedAction doesn't repeat the last N ticks' actions."""
    action = signal_result.get("recommendedAction")
    if action is None or action.get("action") == "skip":
        return _result("no_repeat_action", True, "no action recommended (skip/null)")

    task = (action.get("task") or "").lower().strip()
    if not task:
        return _result("no_repeat_action", True, "no task description to compare")

    # Collect recent action tasks
    recent_tasks: list[str] = []
    for log in recent_logs[:window]:
        log_actions = log.get("actionsConsidered", [])
        for a in log_actions:
            if a.get("chosen"):
                recent_tasks.append((a.get("reason") or a.get("task") or "").lower().strip())

    # Check for near-duplicate (substring match to catch rephrasing)
    for prev_task in recent_tasks:
        if not prev_task:
            continue
        # If >60% of words overlap, consider it a repeat
        task_words = set(task.split())
        prev_words = set(prev_task.split())
        if not task_words or not prev_words:
            continue
        overlap = len(task_words & prev_words) / max(len(task_words), len(prev_words))
        if overlap > 0.6:
            return _result("no_repeat_action", False,
                           f"action task '{task[:60]}' overlaps with recent '{prev_task[:60]}' ({overlap:.0%} word overlap)")

    return _result("no_repeat_action", True,
                   f"action task is distinct from last {window} ticks")


def assert_signal_confidence_threshold(signal_result: dict, threshold: float = 0.5) -> dict:
    """Verify actions are only recommended above the confidence threshold."""
    action = signal_result.get("recommendedAction")
    if action is None or action.get("action") == "skip":
        return _result("signal_confidence_threshold", True, "no action recommended")

    confidence = action.get("confidence")
    if confidence is None:
        return _result("signal_confidence_threshold", False,
                       "action recommended but no confidence value provided")

    if confidence >= threshold:
        return _result("signal_confidence_threshold", True,
                       f"confidence {confidence:.2f} >= threshold {threshold}")
    return _result("signal_confidence_threshold", False,
                   f"confidence {confidence:.2f} < threshold {threshold}")


# ---------------------------------------------------------------------------
# Insight synthesizer assertions
# ---------------------------------------------------------------------------

def assert_insight_char_limit(synth_result: dict, limit: int = 500) -> dict:
    """Verify suggestion+insight stays under the character limit."""
    if synth_result.get("skip", False):
        return _result("insight_char_limit", True, "output skipped")

    suggestion = synth_result.get("suggestion", "")
    insight = synth_result.get("insight", "")
    total = len(suggestion) + len(insight)

    if total <= limit:
        return _result("insight_char_limit", True, f"total {total} chars (limit {limit})")
    return _result("insight_char_limit", False, f"total {total} chars exceeds limit of {limit}")


def assert_skip_reason_specific(synth_result: dict) -> dict:
    """If skip=true, verify the reason is specific (not generic boilerplate)."""
    if not synth_result.get("skip", False):
        return _result("skip_reason_specific", True, "output not skipped")

    reason = (synth_result.get("skipReason") or "").strip()
    if not reason:
        return _result("skip_reason_specific", False, "skip=true but no skipReason provided")

    # Check against known-generic patterns
    generic_phrases = [
        "no new data",
        "nothing new",
        "no updates",
        "insufficient data",
        "not enough information",
        "no changes",
    ]
    reason_lower = reason.lower()
    for phrase in generic_phrases:
        if reason_lower == phrase or (len(reason_lower) < 30 and phrase in reason_lower):
            return _result("skip_reason_specific", False,
                           f"skipReason is too generic: '{reason}'")

    return _result("skip_reason_specific", True, f"skipReason is specific ({len(reason)} chars)")


# ---------------------------------------------------------------------------
# Memory miner assertions
# ---------------------------------------------------------------------------

def assert_miner_references_sources(miner_result: dict, daily_files: list[str]) -> dict:
    """Verify mining findings reference actual source files that were provided."""
    mined = miner_result.get("minedSources", [])
    if not mined:
        return _result("miner_references_sources", True, "no sources mined (early return)")

    # daily_files contains basenames like "2026-02-21.md"
    known_basenames = set(daily_files)
    unknown = [s for s in mined if s not in known_basenames]

    if unknown:
        return _result("miner_references_sources", False,
                       f"minedSources references unknown files: {unknown}")
    return _result("miner_references_sources", True,
                   f"all {len(mined)} mined sources are valid")


# ---------------------------------------------------------------------------
# Cross-script / structural assertions
# ---------------------------------------------------------------------------

def assert_schema_valid(script_name: str, output: dict, schema_errors: list[str]) -> dict:
    """Wrap schema validation result as an assertion."""
    if not schema_errors:
        return _result(f"schema_valid_{script_name}", True, "output matches schema")
    return _result(f"schema_valid_{script_name}", False,
                   f"{len(schema_errors)} schema errors: {'; '.join(schema_errors[:3])}")


def assert_playbook_header_footer_intact(playbook_text: str) -> dict:
    """Verify the playbook still has its mining-index header and effectiveness footer."""
    has_header = "<!-- mining-index:" in playbook_text
    has_footer = "<!-- effectiveness:" in playbook_text

    if has_header and has_footer:
        return _result("playbook_header_footer_intact", True,
                       "both mining-index and effectiveness comments present")
    missing = []
    if not has_header:
        missing.append("mining-index")
    if not has_footer:
        missing.append("effectiveness")
    return _result("playbook_header_footer_intact", False,
                   f"missing playbook comments: {', '.join(missing)}")


# ---------------------------------------------------------------------------
# Trait voice assertions (sinain-core wiring verification)
# ---------------------------------------------------------------------------

def assert_situation_has_active_voice(
    situation_content: str, expected_trait: str | None = None
) -> dict:
    """Check SITUATION.md contains an Active Voice section (after trait wiring).

    Called by tick_evaluator.py when processing live ticks that have SITUATION.md
    content and a trait was selected for that tick.
    """
    has_section = "## Active Voice" in situation_content
    if not has_section:
        return _result("situation_has_active_voice", False, "no '## Active Voice' section")
    if expected_trait and expected_trait not in situation_content:
        return _result("situation_has_active_voice", False,
                       f"section present but '{expected_trait}' not found")
    return _result("situation_has_active_voice", True, "Active Voice section present")


# ---------------------------------------------------------------------------
# Runner: execute all applicable assertions for a tick
# ---------------------------------------------------------------------------

def run_tick_assertions(
    log_entry: dict,
    recent_logs: list[dict],
    playbook_text: str,
    daily_files: list[str],
) -> list[dict]:
    """Run all applicable assertions against a single tick's log entry.

    Returns a list of assertion result dicts.
    """
    results: list[dict] = []

    # Signal analyzer assertions
    signals = log_entry.get("signals")
    if signals is not None:
        results.append(assert_signal_confidence_threshold(
            {"signals": signals, "recommendedAction": log_entry.get("recommendedAction")},
        ))
        results.append(assert_no_repeat_action(
            {"signals": signals, "recommendedAction": log_entry.get("recommendedAction")},
            recent_logs,
        ))

    # Curator assertions — playbookChanges can be {"note": "skipped"} or full output
    curator = log_entry.get("playbookChanges")
    if isinstance(curator, dict) and "changes" in curator:
        curator_with_lines = {**curator}
        if "playbookLines" not in curator_with_lines:
            curator_with_lines["playbookLines"] = curator.get("playbookLines", 0)
        results.append(assert_playbook_under_limit(curator_with_lines))

        directive = log_entry.get("curateDirective", "normal")
        results.append(assert_curator_respected_directive(curator_with_lines, directive))

    # Insight synthesizer assertions — output can be null (pipeline-level skip)
    output = log_entry.get("output")
    if isinstance(output, dict):
        results.append(assert_insight_char_limit(output))
        results.append(assert_skip_reason_specific(output))

    # Mining assertions — log uses miningFindings (str) and minedSources (list)
    mining = log_entry.get("miningResult")
    if mining is not None:
        results.append(assert_miner_references_sources(mining, daily_files))
    elif log_entry.get("minedSources"):
        # Reconstruct mining result from flat log fields
        results.append(assert_miner_references_sources(
            {"minedSources": log_entry.get("minedSources", [])}, daily_files
        ))

    # Playbook health (if we have playbook text)
    if playbook_text:
        results.append(assert_playbook_header_footer_intact(playbook_text))

    return results
