#!/usr/bin/env python3
"""Module Manager — CLI for managing sinain knowledge modules.

Management subcommands (no LLM):
    list, activate, suspend, priority, stack, info, guidance

Extraction subcommand (uses LLM):
    extract — reads playbook + logs, uses LLM to extract domain patterns

Transfer subcommands (no LLM):
    export — package a module as a portable .sinain-module.json bundle
    import — import a module from a .sinain-module.json bundle

Usage:
    python3 module_manager.py --modules-dir modules/ list
    python3 module_manager.py --modules-dir modules/ activate react-native-dev --priority 85
    python3 module_manager.py --modules-dir modules/ suspend react-native-dev
    python3 module_manager.py --modules-dir modules/ priority react-native-dev 90
    python3 module_manager.py --modules-dir modules/ stack
    python3 module_manager.py --modules-dir modules/ info react-native-dev
    python3 module_manager.py --modules-dir modules/ guidance react-native-dev
    python3 module_manager.py --modules-dir modules/ guidance react-native-dev \\
        --set "When user asks about hot reload, suggest Hermes bytecode caching"
    python3 module_manager.py --modules-dir modules/ guidance react-native-dev --clear
    python3 module_manager.py --modules-dir modules/ extract new-domain \\
        --domain "description" --memory-dir memory/ [--min-score 0.3]
    python3 module_manager.py --modules-dir modules/ export ocr-pipeline \\
        [--output /tmp/ocr.sinain-module.json]
    python3 module_manager.py --modules-dir modules/ import bundle.sinain-module.json \\
        [--activate] [--force]
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Registry helpers
# ---------------------------------------------------------------------------

def _registry_path(modules_dir: Path) -> Path:
    return modules_dir / "module-registry.json"


def _load_registry(modules_dir: Path) -> dict:
    path = _registry_path(modules_dir)
    if not path.exists():
        return {"version": 1, "modules": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _save_registry(modules_dir: Path, registry: dict) -> None:
    path = _registry_path(modules_dir)
    path.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _load_manifest(modules_dir: Path, module_id: str) -> dict | None:
    manifest_path = modules_dir / module_id / "manifest.json"
    if not manifest_path.exists():
        return None
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _error(msg: str) -> None:
    """Print error as JSON and exit."""
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Subcommands: management (no LLM)
# ---------------------------------------------------------------------------

def cmd_list(modules_dir: Path, _args: argparse.Namespace) -> None:
    """List all registered modules with their status."""
    registry = _load_registry(modules_dir)
    modules = []
    for mid, entry in registry.get("modules", {}).items():
        manifest = _load_manifest(modules_dir, mid)
        modules.append({
            "id": mid,
            "name": manifest.get("name", mid) if manifest else mid,
            "status": entry.get("status", "unknown"),
            "priority": entry.get("priority", 0),
            "locked": entry.get("locked", False),
            "hasPatterns": (modules_dir / mid / "patterns.md").exists(),
        })
    # Also list unregistered module dirs
    for child in sorted(modules_dir.iterdir()):
        if child.is_dir() and child.name not in registry.get("modules", {}):
            manifest = _load_manifest(modules_dir, child.name)
            if manifest:
                modules.append({
                    "id": child.name,
                    "name": manifest.get("name", child.name),
                    "status": "unregistered",
                    "priority": manifest.get("priority", {}).get("default", 0) if isinstance(manifest.get("priority"), dict) else 0,
                    "locked": False,
                    "hasPatterns": (child / "patterns.md").exists(),
                })
    print(json.dumps({"modules": modules}, ensure_ascii=False))


def cmd_activate(modules_dir: Path, args: argparse.Namespace) -> None:
    """Activate a module (optionally set priority)."""
    module_id = args.module_id
    manifest = _load_manifest(modules_dir, module_id)
    if not manifest:
        _error(f"Module '{module_id}' not found (no manifest.json in {modules_dir / module_id})")

    registry = _load_registry(modules_dir)
    entry = registry.get("modules", {}).get(module_id, {})

    # Determine priority
    priority = args.priority
    if priority is None:
        priority = entry.get("priority") or (
            manifest.get("priority", {}).get("default", 70)
            if isinstance(manifest.get("priority"), dict)
            else 70
        )

    # Validate priority against manifest range
    prio_range = manifest.get("priority", {}).get("range") if isinstance(manifest.get("priority"), dict) else None
    if prio_range and len(prio_range) == 2:
        lo, hi = prio_range
        if not (lo <= priority <= hi):
            _error(f"Priority {priority} outside allowed range [{lo}, {hi}] for module '{module_id}'")

    # Update registry
    registry.setdefault("modules", {})[module_id] = {
        "status": "active",
        "priority": priority,
        "activatedAt": _now_iso(),
        "lastTriggered": entry.get("lastTriggered"),
        "locked": entry.get("locked", manifest.get("locked", False)),
    }
    _save_registry(modules_dir, registry)

    # Fire-and-forget: ingest module patterns into triple store
    import subprocess
    try:
        subprocess.run(
            ["python3", "triple_ingest.py", "--memory-dir",
             str(modules_dir.parent / "memory"),
             "--ingest-module", module_id, "--modules-dir", str(modules_dir),
             "--embed"],
            capture_output=True, timeout=15,
            cwd=str(Path(__file__).parent),
        )
    except Exception:
        pass

    print(json.dumps({
        "activated": module_id,
        "priority": priority,
        "status": "active",
    }, ensure_ascii=False))


def cmd_suspend(modules_dir: Path, args: argparse.Namespace) -> None:
    """Suspend a module (patterns excluded from effective playbook)."""
    module_id = args.module_id
    registry = _load_registry(modules_dir)
    entry = registry.get("modules", {}).get(module_id)

    if not entry:
        _error(f"Module '{module_id}' not found in registry")
    if entry.get("locked"):
        _error(f"Module '{module_id}' is locked and cannot be suspended")

    entry["status"] = "suspended"
    _save_registry(modules_dir, registry)

    # Fire-and-forget: retract module patterns from triple store
    import subprocess
    try:
        subprocess.run(
            ["python3", "triple_ingest.py", "--memory-dir",
             str(modules_dir.parent / "memory"),
             "--retract-module", module_id],
            capture_output=True, timeout=15,
            cwd=str(Path(__file__).parent),
        )
    except Exception:
        pass

    print(json.dumps({"suspended": module_id}, ensure_ascii=False))


def cmd_priority(modules_dir: Path, args: argparse.Namespace) -> None:
    """Change a module's priority."""
    module_id = args.module_id
    new_priority = args.new_priority

    manifest = _load_manifest(modules_dir, module_id)
    if not manifest:
        _error(f"Module '{module_id}' not found")

    # Validate against manifest range
    prio_range = manifest.get("priority", {}).get("range") if isinstance(manifest.get("priority"), dict) else None
    if prio_range and len(prio_range) == 2:
        lo, hi = prio_range
        if not (lo <= new_priority <= hi):
            _error(f"Priority {new_priority} outside allowed range [{lo}, {hi}]")

    registry = _load_registry(modules_dir)
    entry = registry.get("modules", {}).get(module_id)
    if not entry:
        _error(f"Module '{module_id}' not in registry (activate it first)")

    entry["priority"] = new_priority
    _save_registry(modules_dir, registry)
    print(json.dumps({
        "module": module_id,
        "priority": new_priority,
    }, ensure_ascii=False))


def cmd_stack(modules_dir: Path, _args: argparse.Namespace) -> None:
    """Show the active module stack (sorted by priority desc)."""
    registry = _load_registry(modules_dir)
    active = []
    suspended = []
    for mid, entry in registry.get("modules", {}).items():
        info = {
            "id": mid,
            "priority": entry.get("priority", 0),
            "locked": entry.get("locked", False),
        }
        if entry.get("status") == "active":
            active.append(info)
        elif entry.get("status") == "suspended":
            suspended.append(info)
    active.sort(key=lambda m: m["priority"], reverse=True)
    print(json.dumps({"active": active, "suspended": suspended}, ensure_ascii=False))


def cmd_info(modules_dir: Path, args: argparse.Namespace) -> None:
    """Show detailed info about a module."""
    module_id = args.module_id
    manifest = _load_manifest(modules_dir, module_id)
    if not manifest:
        _error(f"Module '{module_id}' not found")

    registry = _load_registry(modules_dir)
    entry = registry.get("modules", {}).get(module_id, {})

    patterns_path = modules_dir / module_id / "patterns.md"
    patterns_lines = 0
    if patterns_path.exists():
        patterns_lines = len(patterns_path.read_text(encoding="utf-8").splitlines())

    guidance_path = modules_dir / module_id / "guidance.md"
    guidance_chars = 0
    if guidance_path.exists():
        guidance_chars = len(guidance_path.read_text(encoding="utf-8"))

    print(json.dumps({
        "id": module_id,
        "manifest": manifest,
        "registry": entry if entry else None,
        "patternsLines": patterns_lines,
        "patternsPath": str(patterns_path),
        "guidanceChars": guidance_chars,
    }, ensure_ascii=False))


def cmd_guidance(modules_dir: Path, args: argparse.Namespace) -> None:
    """View, set, or clear per-module behavioral guidance."""
    module_id = args.module_id
    module_dir = modules_dir / module_id
    manifest = _load_manifest(modules_dir, module_id)
    if not manifest:
        _error(f"Module '{module_id}' not found (no manifest.json in {module_dir})")

    guidance_path = module_dir / "guidance.md"

    if args.clear:
        if guidance_path.exists():
            guidance_path.unlink()
        print(json.dumps({"module": module_id, "guidance": "", "cleared": True}, ensure_ascii=False))
        return

    if args.set is not None:
        guidance_path.write_text(args.set, encoding="utf-8")
        print(json.dumps({
            "module": module_id,
            "guidanceChars": len(args.set),
            "written": True,
        }, ensure_ascii=False))
        return

    # Default: view
    guidance = guidance_path.read_text(encoding="utf-8") if guidance_path.exists() else ""
    print(json.dumps({
        "module": module_id,
        "hasGuidance": bool(guidance),
        "guidance": guidance,
    }, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Subcommand: extract (uses LLM)
# ---------------------------------------------------------------------------

EXTRACT_SYSTEM_PROMPT = """\
You are a knowledge extraction agent for sinain, a personal AI assistant.
Your job: given a playbook and recent log history, extract all patterns related to a specific domain.

Output format — respond with ONLY a JSON object:
{
  "established": ["pattern 1 (score > 0.5)", ...],
  "emerging": ["pattern that appeared recently", ...],
  "vocabulary": ["domain-specific term: definition", ...]
}

Rules:
- Only include patterns genuinely related to the specified domain
- "established" = patterns with strong evidence (multiple occurrences, high scores)
- "emerging" = patterns seen once or twice, plausible but unconfirmed
- "vocabulary" = domain-specific terms, acronyms, tool names with brief definitions
- Be specific — cite concrete behaviors, not generic advice
- If no patterns found for the domain, return empty arrays"""


def cmd_extract(modules_dir: Path, args: argparse.Namespace) -> None:
    """Extract domain patterns from playbook + logs using LLM."""
    # Import LLM utilities (only needed for extract)
    try:
        from common import call_llm, extract_json, read_playbook, read_recent_logs, LLMError
    except ImportError:
        _error("Cannot import common.py — run from sinain-koog/ directory or ensure it's on PYTHONPATH")

    module_id = args.module_id
    domain = args.domain
    memory_dir = args.memory_dir
    min_score = args.min_score

    # Read source data
    playbook = read_playbook(memory_dir)
    recent_logs = read_recent_logs(memory_dir, days=7)

    if not playbook and not recent_logs:
        _error("No playbook or logs found — nothing to extract from")

    # Enrich with knowledge graph context (optional, degrades gracefully)
    kg_context = ""
    try:
        from triple_query import get_related_context
        kg_context = get_related_context(str(memory_dir), [domain], max_chars=1000)
    except Exception:
        pass  # triple store unavailable — proceed without

    # Build user prompt
    parts = [f"## Domain: {domain}"]
    if playbook:
        parts.append(f"\n## Playbook Content\n{playbook}")
    if recent_logs:
        # Summarize logs (keep it compact)
        log_entries = []
        for entry in recent_logs[:20]:
            log_entries.append(json.dumps({
                "ts": entry.get("ts", "?"),
                "signals": entry.get("signals", []),
                "playbookChanges": entry.get("playbookChanges"),
                "output": entry.get("output"),
            }, ensure_ascii=False))
        parts.append(f"\n## Recent Log Entries (last 7 days)\n" + "\n".join(log_entries))
    if kg_context:
        parts.append(f"\n## Knowledge Graph Context\n{kg_context}")
    if min_score:
        parts.append(f"\n## Minimum Score Filter: {min_score}")

    user_prompt = "\n".join(parts)

    try:
        raw = call_llm(EXTRACT_SYSTEM_PROMPT, user_prompt, script="module_manager", json_mode=True)
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        _error(f"LLM extraction failed: {e}")

    established = result.get("established", [])
    emerging = result.get("emerging", [])
    vocabulary = result.get("vocabulary", [])

    # Create module directory
    module_dir = modules_dir / module_id
    module_dir.mkdir(parents=True, exist_ok=True)

    # Generate manifest
    manifest = {
        "id": module_id,
        "name": domain,
        "description": f"Auto-extracted patterns for: {domain}",
        "version": "1.0.0",
        "priority": {
            "default": 70,
            "range": [50, 100],
        },
        "triggers": {},
        "locked": False,
        "extractedAt": _now_iso(),
        "source": "module_manager extract",
    }
    (module_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # Generate patterns.md
    lines = [f"# {domain}\n"]
    if established:
        lines.append("## Established Patterns")
        for p in established:
            lines.append(f"- {p}")
        lines.append("")
    if emerging:
        lines.append("## Emerging Patterns")
        for p in emerging:
            lines.append(f"- {p}")
        lines.append("")
    if vocabulary:
        lines.append("## Domain Vocabulary")
        for v in vocabulary:
            lines.append(f"- {v}")
        lines.append("")

    (module_dir / "patterns.md").write_text("\n".join(lines), encoding="utf-8")

    # Register as suspended (user must explicitly activate)
    registry = _load_registry(modules_dir)
    registry.setdefault("modules", {})[module_id] = {
        "status": "suspended",
        "priority": 70,
        "activatedAt": None,
        "lastTriggered": None,
        "locked": False,
    }
    _save_registry(modules_dir, registry)

    print(json.dumps({
        "extracted": module_id,
        "domain": domain,
        "patternsEstablished": len(established),
        "patternsEmerging": len(emerging),
        "vocabularyTerms": len(vocabulary),
        "modulePath": str(module_dir),
        "status": "suspended",
        "activateWith": f"python3 module_manager.py --modules-dir {modules_dir} activate {module_id}",
    }, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Subcommands: export / import (portable bundles)
# ---------------------------------------------------------------------------

def cmd_export(modules_dir: Path, args: argparse.Namespace) -> None:
    """Export a module as a portable .sinain-module.json bundle."""
    module_id = args.module_id
    module_dir = modules_dir / module_id

    manifest = _load_manifest(modules_dir, module_id)
    if not manifest:
        _error(f"Module '{module_id}' not found (no manifest.json)")

    # Read patterns
    patterns_path = module_dir / "patterns.md"
    patterns = patterns_path.read_text(encoding="utf-8") if patterns_path.exists() else ""

    # Read guidance
    guidance_path = module_dir / "guidance.md"
    guidance = guidance_path.read_text(encoding="utf-8") if guidance_path.exists() else ""

    # Read context files
    context = {}
    context_dir = module_dir / "context"
    if context_dir.is_dir():
        for f in sorted(context_dir.iterdir()):
            if f.is_file():
                try:
                    context[f.name] = f.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    pass  # skip binary files

    bundle = {
        "format": "sinain-module-v1",
        "moduleId": module_id,
        "exportedAt": _now_iso(),
        "manifest": manifest,
        "patterns": patterns,
        "guidance": guidance,
        "context": context,
    }

    output_path = Path(args.output) if args.output else Path(f"{module_id}.sinain-module.json")
    output_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(json.dumps({
        "exported": module_id,
        "outputPath": str(output_path),
        "patternsChars": len(patterns),
        "guidanceChars": len(guidance),
        "contextFiles": len(context),
    }, ensure_ascii=False))


def cmd_import(modules_dir: Path, args: argparse.Namespace) -> None:
    """Import a module from a .sinain-module.json bundle."""
    bundle_path = Path(args.bundle)
    if not bundle_path.exists():
        _error(f"Bundle file not found: {bundle_path}")

    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        _error(f"Invalid bundle file: {e}")

    # Validate format
    if bundle.get("format") != "sinain-module-v1":
        _error(f"Unknown bundle format: {bundle.get('format')} (expected sinain-module-v1)")

    module_id = bundle.get("moduleId")
    if not module_id:
        _error("Bundle missing moduleId")

    module_dir = modules_dir / module_id

    # Check for existing module
    if module_dir.exists() and not args.force:
        _error(f"Module '{module_id}' already exists. Use --force to overwrite.")

    # Create module directory
    module_dir.mkdir(parents=True, exist_ok=True)

    # Write manifest (stamp with import metadata)
    manifest = bundle.get("manifest", {})
    manifest["importedAt"] = _now_iso()
    manifest["source"] = "module_manager import"
    manifest["importedFrom"] = str(bundle_path.name)
    (module_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # Write patterns
    patterns = bundle.get("patterns", "")
    if patterns:
        (module_dir / "patterns.md").write_text(patterns, encoding="utf-8")

    # Write guidance
    guidance = bundle.get("guidance", "")
    if guidance:
        (module_dir / "guidance.md").write_text(guidance, encoding="utf-8")

    # Write context files
    context = bundle.get("context", {})
    if context:
        context_dir = module_dir / "context"
        context_dir.mkdir(exist_ok=True)
        for fname, content in context.items():
            (context_dir / fname).write_text(content, encoding="utf-8")

    # Register in registry
    registry = _load_registry(modules_dir)
    status = "active" if args.activate else "suspended"
    priority = manifest.get("priority", {}).get("default", 70) if isinstance(manifest.get("priority"), dict) else 70
    registry.setdefault("modules", {})[module_id] = {
        "status": status,
        "priority": priority,
        "activatedAt": _now_iso() if args.activate else None,
        "lastTriggered": None,
        "locked": False,
    }
    _save_registry(modules_dir, registry)

    # If activating, fire-and-forget KG ingestion (same as cmd_activate)
    if args.activate:
        import subprocess
        try:
            subprocess.run(
                ["python3", "triple_ingest.py", "--memory-dir",
                 str(modules_dir.parent / "memory"),
                 "--ingest-module", module_id, "--modules-dir", str(modules_dir),
                 "--embed"],
                capture_output=True, timeout=15,
                cwd=str(Path(__file__).parent),
            )
        except Exception:
            pass

    print(json.dumps({
        "imported": module_id,
        "status": status,
        "priority": priority,
        "patternsChars": len(patterns),
        "contextFiles": len(context),
        "modulePath": str(module_dir),
    }, ensure_ascii=False))


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Sinain Knowledge Module Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--modules-dir", required=True, type=Path,
        help="Path to modules/ directory",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # list
    subparsers.add_parser("list", help="List all modules")

    # activate
    p_act = subparsers.add_parser("activate", help="Activate a module")
    p_act.add_argument("module_id", help="Module ID")
    p_act.add_argument("--priority", type=int, default=None, help="Set priority (default: from manifest)")

    # suspend
    p_sus = subparsers.add_parser("suspend", help="Suspend a module")
    p_sus.add_argument("module_id", help="Module ID")

    # priority
    p_pri = subparsers.add_parser("priority", help="Change module priority")
    p_pri.add_argument("module_id", help="Module ID")
    p_pri.add_argument("new_priority", type=int, help="New priority value")

    # stack
    subparsers.add_parser("stack", help="Show active module stack")

    # info
    p_info = subparsers.add_parser("info", help="Show module details")
    p_info.add_argument("module_id", help="Module ID")

    # guidance
    p_guid = subparsers.add_parser("guidance", help="View/set/clear per-module behavioral guidance")
    p_guid.add_argument("module_id", help="Module ID")
    p_guid.add_argument("--set", default=None, help="Set guidance text")
    p_guid.add_argument("--clear", action="store_true", help="Clear guidance")

    # extract
    p_ext = subparsers.add_parser("extract", help="Extract domain patterns using LLM")
    p_ext.add_argument("module_id", help="Module ID to create")
    p_ext.add_argument("--domain", required=True, help="Domain description")
    p_ext.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    p_ext.add_argument("--min-score", type=float, default=0.3, help="Minimum pattern score (default: 0.3)")

    # export
    p_exp = subparsers.add_parser("export", help="Export module as portable bundle")
    p_exp.add_argument("module_id", help="Module ID to export")
    p_exp.add_argument("--output", default=None, help="Output file path (default: <id>.sinain-module.json)")

    # import
    p_imp = subparsers.add_parser("import", help="Import module from portable bundle")
    p_imp.add_argument("bundle", help="Path to .sinain-module.json bundle file")
    p_imp.add_argument("--activate", action="store_true", help="Activate module immediately after import")
    p_imp.add_argument("--force", action="store_true", help="Overwrite existing module")

    args = parser.parse_args()

    commands = {
        "list": cmd_list,
        "activate": cmd_activate,
        "suspend": cmd_suspend,
        "priority": cmd_priority,
        "stack": cmd_stack,
        "info": cmd_info,
        "guidance": cmd_guidance,
        "extract": cmd_extract,
        "export": cmd_export,
        "import": cmd_import,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args.modules_dir, args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
