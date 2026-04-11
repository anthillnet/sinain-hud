"""Ingestion pipeline — benchmark conversations → sinain triplestore.

Runs session_distiller.py + knowledge_integrator.py via subprocess (exact production path).
Caches results aggressively to avoid repeated LLM calls.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from subprocess import run, PIPE, TimeoutExpired

from .base_adapter import BenchmarkInstance
from .config import DISTILLER_TIMEOUT_S, INTEGRATOR_TIMEOUT_S


def _scripts_dir() -> Path:
    """Locate sinain-memory scripts directory."""
    return Path(__file__).resolve().parent.parent.parent


def _content_hash(sessions: list[list[dict]]) -> str:
    """Hash session content for caching."""
    raw = json.dumps(sessions, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _run_script(script_name: str, args: list[str], timeout: int) -> str | None:
    """Run a Python script from sinain-memory, return stdout or None on failure."""
    script_path = _scripts_dir() / script_name
    if not script_path.exists():
        print(f"[ingest] {script_name} not found at {script_path}")
        return None

    env = {**os.environ, "PYTHONPATH": str(_scripts_dir())}
    # Ensure a working model is available (common.py defaults may reference unreleased models)
    if "SINAIN_BENCH_MODEL" in os.environ:
        env["SINAIN_FAST_MODEL"] = os.environ["SINAIN_BENCH_MODEL"]
    try:
        result = run(
            ["python3", str(script_path)] + args,
            capture_output=True, text=True, timeout=timeout, env=env,
        )
        if result.returncode != 0:
            print(f"[ingest] {script_name} failed: {result.stderr[:200]}")
            return None
        return result.stdout.strip()
    except TimeoutExpired:
        print(f"[ingest] {script_name} timed out ({timeout}s)")
        return None


def ingest_instance(
    instance: BenchmarkInstance,
    cache_dir: Path,
) -> Path | None:
    """Ingest a benchmark instance into a triplestore. Returns db_path or None.

    Uses caching: if the same haystack was already ingested, returns the cached DB.
    """
    ch = _content_hash(instance.sessions)
    cache_path = cache_dir / "stores" / f"{ch}.db"

    if cache_path.exists():
        return cache_path

    cache_path.parent.mkdir(parents=True, exist_ok=True)

    # Create temp memory directory
    tmp = tempfile.mkdtemp(prefix="sinain-bench-")
    mem_dir = Path(tmp) / "memory"
    for subdir in ["", "playbook-logs", "playbook-archive"]:
        (mem_dir / subdir).mkdir(parents=True, exist_ok=True)

    # Write a minimal playbook so integrator doesn't fail
    (mem_dir / "sinain-playbook.md").write_text("# Sinain Playbook\n\n(benchmark run)\n")

    success = False
    try:
        # Batch sessions into chunks of ~10 for fewer LLM calls.
        # Each chunk becomes one distiller call with a combined transcript.
        BATCH_SIZE = 10
        num_sessions = len(instance.sessions)
        batch_idx = 0

        for start in range(0, num_sessions, BATCH_SIZE):
            batch = instance.sessions[start:start + BATCH_SIZE]
            # Flatten batch into one transcript
            combined: list[dict] = []
            for session in batch:
                combined.extend(session)
            if len(combined) < 3:
                continue

            first_ts = combined[0].get("ts", "2025-01-01T10:00:00Z")
            meta = json.dumps({
                "ts": first_ts,
                "sessionKey": f"benchmark-batch-{batch_idx}",
                "durationMs": len(combined) * 30000,
            })
            batch_idx += 1

            # Step 1: Distill the batch
            digest_json = _run_script("session_distiller.py", [
                "--memory-dir", str(mem_dir),
                "--transcript", json.dumps(combined),
                "--session-meta", meta,
            ], DISTILLER_TIMEOUT_S)

            if not digest_json:
                continue

            try:
                digest = json.loads(digest_json)
            except json.JSONDecodeError:
                continue

            if digest.get("isEmpty") or digest.get("error"):
                continue

            # Step 2: Integrate into knowledge graph
            _run_script("knowledge_integrator.py", [
                "--memory-dir", str(mem_dir),
                "--digest", json.dumps(digest),
            ], INTEGRATOR_TIMEOUT_S)

        # Copy the resulting DB to cache
        db_path = mem_dir / "knowledge-graph.db"
        if db_path.exists() and db_path.stat().st_size > 0:
            shutil.copy2(db_path, cache_path)
            success = True

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return cache_path if success else None


def get_knowledge_doc(db_path: Path) -> str:
    """Render a sinain-knowledge.md style document from a triplestore."""
    import sys
    sys.path.insert(0, str(_scripts_dir()))
    from graph_query import query_top_facts, format_facts_text

    facts = query_top_facts(str(db_path), limit=30)
    if not facts:
        return "(no knowledge available)"
    return format_facts_text(facts, max_chars=6000)
