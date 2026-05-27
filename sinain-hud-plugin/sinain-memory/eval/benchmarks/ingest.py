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


_PIPELINE_VERSION_FILES: tuple[str, ...] = (
    "session_distiller.py",
    "knowledge_integrator.py",
)


def _distillation_pipeline_version() -> str:
    """Short content hash of pipeline files whose output the DB cache captures.

    Hashes the LLM-step (session_distiller.py — prompt + chunk/retry logic) and
    the deterministic-step (knowledge_integrator.py — fact-to-graph conversion)
    together because the cache stores the FINAL DB, not the intermediate digest.
    Either changing means the cached DB may no longer reflect what current
    code would produce.

    Auto-versioning by file content (not a manual version string) eliminates
    the human-error path that caused the Stage 2 blockage — 508 cached DBs
    went stale w.r.t. the rewritten SYSTEM_PROMPT because the cache key didn't
    reflect prompt content and nobody bumped a version constant.

    Returns empty string if files are missing (preserves legacy hash for
    environments without the pipeline scripts — defensive but unlikely path).
    """
    h = hashlib.sha256()
    for fname in _PIPELINE_VERSION_FILES:
        p = _scripts_dir() / fname
        if not p.exists():
            return ""
        h.update(p.read_bytes())
    return h.hexdigest()[:8]


def _content_hash(sessions: list[list[dict]]) -> str:
    """Hash session content for caching.

    Cache key salts (mixed into the final sha256):
      - SINAIN_BENCH_MODEL: per-model cache isolation, so different
        distiller candidates land in different cache slots.
      - distillation pipeline version: auto-derived sha256 of
        session_distiller.py + knowledge_integrator.py contents, so prompt
        or pipeline edits auto-invalidate stale caches. See
        `_distillation_pipeline_version()` for rationale.

    Empty model salt preserves the legacy cache slot for production runs
    that don't override the model AND keep pipeline files untouched; the
    moment either changes, a new slot is opened naturally.
    """
    raw = json.dumps(sessions, sort_keys=True, ensure_ascii=False)
    model_salt = os.environ.get("SINAIN_BENCH_MODEL", "")
    pipeline_salt = _distillation_pipeline_version()
    ablate_salt = (
        os.environ.get("SINAIN_ABLATE", "none")
        + ":"
        + os.environ.get("SINAIN_ABLATE_MODE", "passthrough")
    )
    return hashlib.sha256(
        (raw + "|" + model_salt + "|" + pipeline_salt + "|" + ablate_salt).encode()
    ).hexdigest()[:16]


def _resolve_batch_size() -> int:
    """Pick destination-aware distillation batch size (decision D2).

    Cloud destinations benefit from larger batches to amortize per-call fees;
    local destinations have zero per-call cost and must keep per-batch prompt
    size small enough to fit the 30s distiller timeout (Phase A finding).

    See `docs/memory-v2-local-first.md § "Distillation flow"` for the locked
    decision. Production (no SINAIN_BENCH_MODEL override) keeps today's
    BATCH_SIZE=10 — this is a benchmark-time knob until Phase B lands the
    runtime equivalent in LocalCurationService.
    """
    bench_model = os.environ.get("SINAIN_BENCH_MODEL", "")
    if bench_model.startswith("ollama/"):
        return 2
    return 10


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
    if "SINAIN_ABLATE" in os.environ:
        env["SINAIN_ABLATE"] = os.environ["SINAIN_ABLATE"]
    if "SINAIN_ABLATE_MODE" in os.environ:
        env["SINAIN_ABLATE_MODE"] = os.environ["SINAIN_ABLATE_MODE"]
    try:
        result = run(
            ["python3", str(script_path)] + args,
            capture_output=True, text=True, timeout=timeout, env=env,
        )
        if result.returncode != 0:
            # Increased truncate limit so the actual error (not just traceback header) is visible
            print(f"[ingest] {script_name} failed:\n{result.stderr[:2000]}")
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
        # Batch sessions into chunks. Cloud-default 10 (minimize OpenRouter
        # per-call fees); local-bench routes get 2 (fits the 30s distiller
        # budget). See _resolve_batch_size and D2 in the v2 design doc.
        BATCH_SIZE = _resolve_batch_size()
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

            # Step 1: Distill the batch (or ablate)
            ablate = os.environ.get("SINAIN_ABLATE", "none")
            ablate_mode = os.environ.get("SINAIN_ABLATE_MODE", "passthrough")
            if ablate == "distiller":
                from eval.benchmarks.ablation.distiller_stub import build_stub_digest
                digest = build_stub_digest(combined, mode=ablate_mode, gold_facts=None)
                digest_json = json.dumps(digest, ensure_ascii=False)
            else:
                digest_json = _run_script("session_distiller.py", [
                    "--memory-dir", str(mem_dir),
                    "--transcript", json.dumps(combined),
                    "--session-meta", meta,
                ], DISTILLER_TIMEOUT_S)

            if not digest_json:
                continue

            try:
                digest = json.loads(digest_json) if isinstance(digest_json, str) else digest
            except json.JSONDecodeError:
                continue

            if digest.get("isEmpty") or digest.get("error"):
                continue

            # Step 2: Integrate into knowledge graph (or ablate)
            # Pass --transcript to enable Proposal A zero-LLM typed-link
            # extraction inside the integrator (auto:-prefixed edges, conf=0.6).
            if ablate == "integrator":
                from eval.benchmarks.ablation.integrator_stub import apply_stub_integration
                apply_stub_integration(mem_dir, digest, mode=ablate_mode)
                continue
            _run_script("knowledge_integrator.py", [
                "--memory-dir", str(mem_dir),
                "--digest", json.dumps(digest),
                "--transcript", json.dumps(combined),
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
