#!/usr/bin/env python3
"""Restore a sinain knowledge snapshot into the bare agent workspace.

Reads ~/.sinain/knowledge-snapshots/snapshot.json and populates
~/.openclaw/workspace/memory/ with playbook, modules, and logs.

Also copies sinain-memory/ Python scripts into the workspace for
the MCP server to call.
"""

import json
import os
import shutil
import sys
from pathlib import Path

SNAPSHOT_PATH = Path.home() / ".sinain" / "knowledge-snapshots" / "snapshot.json"
WORKSPACE = Path.home() / ".openclaw" / "workspace"
MEMORY_DIR = WORKSPACE / "memory"
MODULES_DIR = WORKSPACE / "modules"

# sinain-memory scripts source (relative to this script's repo)
SCRIPT_DIR = Path(__file__).resolve().parent.parent / "sinain-hud-plugin" / "sinain-memory"


def restore():
    if not SNAPSHOT_PATH.exists():
        print(f"ERROR: Snapshot not found at {SNAPSHOT_PATH}")
        sys.exit(1)

    print(f"Loading snapshot from {SNAPSHOT_PATH}...")
    with open(SNAPSHOT_PATH) as f:
        snap = json.load(f)

    print(f"  Version: {snap.get('version')}")
    print(f"  Exported at: {snap.get('exportedAt')}")
    print(f"  From: {snap.get('exportedFrom')}")

    # Create directories
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    MODULES_DIR.mkdir(parents=True, exist_ok=True)
    (MEMORY_DIR / "playbook-archive").mkdir(exist_ok=True)
    (MEMORY_DIR / "playbook-logs").mkdir(exist_ok=True)

    # 1. Restore playbook
    pb = snap["playbook"]
    if isinstance(pb, dict):
        if pb.get("effective"):
            (MEMORY_DIR / "playbook.md").write_text(pb["effective"])
            print(f"  Restored effective playbook ({len(pb['effective'])} chars)")
        if pb.get("base"):
            (MEMORY_DIR / "playbook-base.md").write_text(pb["base"])
            print(f"  Restored base playbook ({len(pb['base'])} chars)")
        if pb.get("archive"):
            for i, entry in enumerate(pb["archive"]):
                if isinstance(entry, str):
                    (MEMORY_DIR / "playbook-archive" / f"archive-{i}.md").write_text(entry)
                elif isinstance(entry, dict) and entry.get("content"):
                    fname = entry.get("label", f"archive-{i}") + ".md"
                    (MEMORY_DIR / "playbook-archive" / fname).write_text(entry["content"])
            print(f"  Restored {len(pb['archive'])} archive entries")

    # 2. Restore modules
    mods = snap.get("modules", {})
    registry = mods.get("registry", {})
    if registry:
        (MODULES_DIR / "module-registry.json").write_text(
            json.dumps(registry, indent=2)
        )
        print(f"  Restored module registry")

    items = mods.get("items", [])
    for item in items:
        if isinstance(item, dict):
            name = item.get("name", "unknown")
            mod_dir = MODULES_DIR / name
            mod_dir.mkdir(exist_ok=True)
            if item.get("guidance"):
                (mod_dir / "guidance.md").write_text(item["guidance"])
            if item.get("patterns"):
                (mod_dir / "patterns.md").write_text(item["patterns"])
            print(f"  Restored module: {name}")

    # 3. Restore logs
    logs = snap.get("logs", {})
    if logs.get("sessionSummaries"):
        summaries = logs["sessionSummaries"]
        if isinstance(summaries, list):
            for i, s in enumerate(summaries[-20:]):  # Keep last 20
                if isinstance(s, dict):
                    ts = s.get("ts", f"entry-{i}")
                    (MEMORY_DIR / "playbook-logs" / f"summary-{ts}.json").write_text(
                        json.dumps(s, indent=2)
                    )
            print(f"  Restored {min(len(summaries), 20)} session summaries")
        elif isinstance(summaries, str):
            (MEMORY_DIR / "session-summaries.json").write_text(summaries)
            print("  Restored session summaries (raw)")

    if logs.get("recentPlaybookLogs"):
        pblogs = logs["recentPlaybookLogs"]
        if isinstance(pblogs, list):
            # Write as JSONL
            lines = []
            for entry in pblogs:
                lines.append(json.dumps(entry) if isinstance(entry, dict) else str(entry))
            (MEMORY_DIR / "playbook-logs" / "restored.jsonl").write_text("\n".join(lines) + "\n")
            print(f"  Restored {len(pblogs)} playbook log entries")

    # 4. Copy triplestore if present
    triplestore_src = SNAPSHOT_PATH.parent / "triples.db"
    if triplestore_src.exists():
        triplestore_dst = MEMORY_DIR / "triplestore.db"
        if not triplestore_dst.exists():
            print(f"  Copying triplestore ({triplestore_src.stat().st_size / 1024 / 1024:.0f} MB)...")
            shutil.copy2(triplestore_src, triplestore_dst)
            print(f"  Restored triplestore.db")
        else:
            print(f"  Triplestore already exists, skipping")

    # 5. Deploy sinain-memory scripts to workspace
    scripts_dst = WORKSPACE / "sinain-memory"
    if SCRIPT_DIR.exists():
        if scripts_dst.exists():
            shutil.rmtree(scripts_dst)
        shutil.copytree(SCRIPT_DIR, scripts_dst)
        print(f"  Deployed sinain-memory scripts from {SCRIPT_DIR}")
    else:
        print(f"  WARNING: sinain-memory scripts not found at {SCRIPT_DIR}")

    print(f"\nDone! Workspace populated at {WORKSPACE}")
    print(f"  memory/: {sum(1 for _ in MEMORY_DIR.rglob('*') if _.is_file())} files")
    print(f"  modules/: {sum(1 for _ in MODULES_DIR.rglob('*') if _.is_file())} files")


if __name__ == "__main__":
    restore()
