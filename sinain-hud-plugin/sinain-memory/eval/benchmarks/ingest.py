"""Ingestion pipeline — benchmark conversations → sinain triplestore.

Runs session_distiller.py + knowledge_integrator.py via subprocess (exact production path).
Caches results aggressively to avoid repeated LLM calls.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
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
    "coreference.py",  # Stage A — changes to coref logic must invalidate the store cache
    "entity_canonicalizer.py",  # E1 — phonetic/fuzzy entity merge affects graph nodes
    "asr_nec.py",  # ASR-C — named-entity correction rewrites transcript pre-distill
)


def _distillation_pipeline_version() -> str:
    """Short content hash of pipeline files whose output the DB cache captures.

    Hashes the LLM-step (session_distiller.py — prompt + chunk/retry logic),
    the deterministic-step (knowledge_integrator.py — fact-to-graph conversion),
    AND this ingest.py file (batching strategy, env-var routing, dispatch).
    All three can change what ends up in the cached DB. Either changing means
    the cached DB may no longer reflect what current code would produce.

    2026-05-27: ingest.py added to the hash after a BATCH_SIZE change failed
    to invalidate cached DBs. Same failure mode as the Stage 2 incident
    (508 stale DBs because the cache key didn't reflect SYSTEM_PROMPT
    content). See project_2026-05-25_eval_cache_invalidation_gap.md.

    Returns empty string if files are missing (preserves legacy hash for
    environments without the pipeline scripts — defensive but unlikely path).
    """
    h = hashlib.sha256()
    for fname in _PIPELINE_VERSION_FILES:
        p = _scripts_dir() / fname
        if not p.exists():
            return ""
        h.update(p.read_bytes())
    # ingest.py itself — batching / dispatch / env-routing affects DB output.
    # Wrap in try/except in case the file is being edited or moved mid-run
    # (matches the legacy "files missing → empty hash" fallback).
    try:
        h.update(Path(__file__).read_bytes())
    except (FileNotFoundError, OSError):
        return ""
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
    # Stage A coref toggle — coref-on vs coref-off must land in different cache
    # slots, else an A/B run would cache-hit the wrong store.
    coref_salt = os.environ.get("SINAIN_COREF", "1")  # default-ON (see coreference.py)
    # E1 entity-canonicalization toggle — default ON. Mixed in so a CANON on/off
    # A/B doesn't cache-hit the wrong store. Default "1" so the normal (E1-on)
    # path gets a stable slot distinct from any legacy CANON-absent cache.
    canon_salt = os.environ.get("SINAIN_CANON", "1")
    # ASR-C named-entity correction toggle — default ON; rewrites transcript
    # pre-distill so NEC on/off must land in distinct cache slots.
    nec_salt = os.environ.get("SINAIN_NEC", "1")
    # T1-RECON cross-session consolidation toggle — default OFF. Env-gated salt (NOT a
    # _PIPELINE_VERSION_FILES entry) so RECON-off cache-hits existing stores and only
    # RECON-on opens a fresh slot. (When iterating reconstruct.py, rm the recon store.)
    recon_salt = os.environ.get("SINAIN_RECON", "")
    # #2 manifold canonicalization toggle — default OFF. Env-gated salt (NOT a
    # _PIPELINE_VERSION_FILES entry) so canon-off cache-hits existing stores and only
    # canon-on opens a fresh slot. (When iterating _manifold_canonicalize_graph, rm the store.)
    manifold_salt = os.environ.get("SINAIN_MANIFOLD_CANON", "")
    # #1 surprisal salience gate toggle — default OFF. Env-gated salt (NOT hashed) so
    # surprisal-off cache-hits existing stores; surprisal-on (+ its θ/g_floor) opens a fresh slot.
    surprisal_salt = (os.environ.get("SINAIN_SURPRISAL_SALIENCE", "")
                      + os.environ.get("SINAIN_SALIENCE_LR_THETA", "")
                      + os.environ.get("SINAIN_SALIENCE_GFLOOR", ""))
    # #6 coverage gap-fill toggle — default OFF. Env-gated salt (NOT hashed).
    gapfill_salt = os.environ.get("SINAIN_GAPFILL", "")
    # #6b recurrence importance toggle — default OFF.
    recurrence_salt = os.environ.get("SINAIN_RECURRENCE", "") + os.environ.get("SINAIN_RECURRENCE_DROP", "")
    # Tier-1 write-time slot supersession toggle — default OFF. Env-gated salt (NOT
    # hashed) so slot-off cache-hits existing stores and only slot-on opens a fresh
    # slot — required for a correct reingest A/B (supersession is write-time).
    slot_salt = os.environ.get("SINAIN_SLOT_SUPERSEDE", "")
    return hashlib.sha256(
        (raw + "|" + model_salt + "|" + pipeline_salt + "|" + ablate_salt
         + "|coref:" + coref_salt + "|canon:" + canon_salt + "|nec:" + nec_salt
         + "|recon:" + recon_salt + "|mcanon:" + manifold_salt
         + "|surp:" + surprisal_salt + "|gap:" + gapfill_salt
         + "|recur:" + recurrence_salt + "|slot:" + slot_salt).encode()
    ).hexdigest()[:16]


def _resolve_distiller_timeout() -> int:
    """Pick destination-aware distiller subprocess timeout.

    Local (Ollama) models: 90s. phi4-mini averages 4-8s warm but long-input
    sessions push past 30s; first-call or model-swap warmup adds 3-5s on top.

    Cloud (OpenRouter) models: 60s. The original 30s budget was sized for
    Phase A bench inputs (~5K chars). LongMemEval-S sessions reach 12-20
    turns × ~1K chars and structured-JSON output for "up to 15 facts" can
    take 25-40s on gemini-2.5-flash under network jitter or model load.
    Verified 2026-05-27: q2 cloud run timed out 3/45 batches at 30s, and
    one of those was the answer-session (session[7], "45 minutes commute")
    → graph missing answer → QA returned "I don't know" → paper_label=0.
    60s catches the tail without masking genuine hangs.

    2026-06-01: even 60s dropped a batch on gpt4_fa19884c during a full 36-q
    re-distill (sequential distills contend for the memory-constrained box, so
    tail latency stretches past 60s). Bumped to 90s; the distill loop also
    retries once at 2x on failure, so a transient slow batch no longer silently
    loses its facts. Genuine hangs still surface (loop gives up after the retry).
    """
    bench_model = os.environ.get("SINAIN_BENCH_MODEL", "")
    if bench_model.startswith("ollama/"):
        return 120
    return 90


def _resolve_batch_size() -> int:
    """Pick distillation batch size.

    2026-05-27 (trace finding): both branches were emitting BATCH=10 on cloud
    and BATCH=2 on local; flattening 10 sessions × ~17K chars/session into
    one transcript (~125K chars) blew past gemini-2.5-flash structured-output
    capacity. The distiller dropped its facts[] array entirely (feat branch)
    and merged 40 distinct dated sessions into 4 narrative blobs in the
    integrator — uniform "I don't know" answers, subset n=18 returned 0.0%.

    Per-session distillation (~17K chars) preserves the full schema; the
    cost-vs-correctness amortization rationale that motivated BATCH=10
    turns out to be ~$1.50 saved per n=500 benchmark run — not worth the
    structured-output collapse. Production session boundaries fire every
    few minutes (LocalCurationService.onFull); BATCH=1 means one distiller
    call per boundary, ≤5% CPU at 8s/call local-model latency.

    Both branches return 1 — resolver shape kept for future flexibility.
    """
    bench_model = os.environ.get("SINAIN_BENCH_MODEL", "")
    if bench_model.startswith("ollama/"):
        return 1
    return 1


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


_DIGIT_UNIT_RE = re.compile(r"\b(\d{1,4})(\s?)(k|km|mi|m)\b", re.IGNORECASE)


def _ground_quantities(text: str, source_low: str) -> str:
    """Correct digit-repetition hallucinations in distance/quantity tokens against
    the source transcript. Deterministic + conservative: only rewrites a token that
    is ABSENT from the source when collapsing a run of repeated digits yields a
    variant that IS present verbatim (e.g. distiller wrote "55k" but the transcript
    only says "5k" → "5k"). Never touches legitimately-computed values (no source
    variant ⇒ left unchanged). Fixes the gemini "5K"→"55k" class that splits one
    evolving metric into two and hides the latest value (6a1eabeb)."""
    if not text or not source_low:
        return text

    def _fix(m: "re.Match") -> str:
        tok = m.group(0)
        if tok.lower() in source_low:
            return tok
        digits, sep, unit = m.group(1), m.group(2), m.group(3)
        collapsed = re.sub(r"(\d)\1+", r"\1", digits)
        if collapsed != digits:
            cand = f"{collapsed}{sep}{unit}"
            if cand.lower() in source_low:
                return cand
        return tok

    return _DIGIT_UNIT_RE.sub(_fix, text)


def _ground_digest_facts(digest: dict, source_low: str) -> dict:
    """Apply _ground_quantities to every fact text in a digest (in place-ish)."""
    if not isinstance(digest, dict):
        return digest
    facts = digest.get("facts")
    if isinstance(facts, list):
        new = []
        for f in facts:
            if isinstance(f, str):
                new.append(_ground_quantities(f, source_low))
            elif isinstance(f, dict) and isinstance(f.get("text"), str):
                f = {**f, "text": _ground_quantities(f["text"], source_low)}
                new.append(f)
            else:
                new.append(f)
        digest = {**digest, "facts": new}
    return digest


def ingest_instance(
    instance: BenchmarkInstance,
    cache_dir: Path,
) -> Path | None:
    """Ingest a benchmark instance into a triplestore. Returns db_path or None.

    Uses caching: if the same haystack was already ingested, returns the cached DB.
    """
    ch = _content_hash(instance.sessions)
    cache_path = cache_dir / "stores" / f"{ch}.db"

    # Option A (raw episodic hybrid): write a raw-chunk sidecar from the source
    # sessions — independent of distillation, so it populates even on cache-hit.
    try:
        sys.path.insert(0, str(_scripts_dir()))
        from raw_store import write_chunks
        chunk_texts = []
        for sess in instance.sessions:
            parts = [(t.get("content") or t.get("text") or "") for t in sess]
            parts = [p for p in parts if p]
            if parts:
                chunk_texts.append("\n".join(parts))
        n_raw = write_chunks(str(cache_path), chunk_texts)
        print(f"[ingest] raw_store: wrote {n_raw} chunk(s) sidecar for {cache_path.name}", file=sys.stderr)
    except Exception as e:
        print(f"[ingest] raw_store write FAILED (non-fatal): {e}", file=sys.stderr)

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
                ], _resolve_distiller_timeout())
                # Retry once at 2x budget on timeout/failure. A dropped batch
                # permanently loses its facts (no resume below), silently sinking
                # any question whose answer lives in that batch (gpt4_fa19884c:
                # 60s timeout → graph missing the answer → QA "I don't know").
                # The retry recovers transient model latency / bench contention.
                if not digest_json:
                    print(f"  [distill] batch {batch_idx} empty/timeout — retry @2x",
                          file=sys.stderr)
                    digest_json = _run_script("session_distiller.py", [
                        "--memory-dir", str(mem_dir),
                        "--transcript", json.dumps(combined),
                        "--session-meta", meta,
                    ], _resolve_distiller_timeout() * 2)

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
            # --transcript restored 2026-05-28: knowledge_integrator now accepts
            # it and runs the gbrain Proposal A zero-LLM extractors
            # (extract_user_attributes + extract_auto_edges) post-LLM. Topic-
            # robust safety net for weak distillers that drop facts.
            # Source-grounding: correct digit-repetition quantity hallucinations
            # (e.g. "55k"→"5k") against THIS batch's transcript before integration.
            _src_low = " ".join(
                (t.get("content") or t.get("text") or "") for t in combined
            ).lower()
            digest = _ground_digest_facts(digest, _src_low)
            _run_script("knowledge_integrator.py", [
                "--memory-dir", str(mem_dir),
                "--digest", json.dumps(digest),
                "--transcript", json.dumps(combined),
            ], INTEGRATOR_TIMEOUT_S)

        # T1-RECON: cross-session consolidation pass (gated SINAIN_RECON, default OFF).
        # Reads the just-built graph, asks ONE LLM call for enumeration + current-state
        # summary facts, and integrates them via the proven integrator path. Fail-open.
        sys.stderr.write(f"[recon-wire] SINAIN_RECON={os.environ.get('SINAIN_RECON')!r}\n")
        if os.environ.get("SINAIN_RECON") == "1":
            sys.stderr.write(f"[recon-wire] running on {mem_dir / 'knowledge-graph.db'}\n")
            try:
                import reconstruct
                # Pass the INTACT session text (turn contents joined with newlines)
                # so T1-RECON entity-attribution can parse "Entity:\n* item" lists
                # before windowed chunking splits the header from its bullets.
                _raw_text = "\n".join(
                    (t.get("content") or t.get("text") or "")
                    for sess in instance.sessions for t in sess
                )
                _recon_digest = reconstruct.build_consolidated_digest(
                    str(mem_dir / "knowledge-graph.db"), raw_text=_raw_text)
                _rn = len((_recon_digest or {}).get("facts") or [])
                sys.stderr.write(f"[recon-wire] consolidated {_rn} facts\n")
                if _recon_digest and _recon_digest.get("facts"):
                    # Ground recon facts against the FULL haystack transcript
                    # (consolidation can re-introduce "55k" from any session).
                    _full_low = " ".join(
                        (t.get("content") or t.get("text") or "")
                        for sess in instance.sessions for t in sess
                    ).lower()
                    _recon_digest = _ground_digest_facts(_recon_digest, _full_low)
                    _run_script("knowledge_integrator.py", [
                        "--memory-dir", str(mem_dir),
                        "--digest", json.dumps(_recon_digest),
                    ], INTEGRATOR_TIMEOUT_S)
            except Exception as e:
                sys.stderr.write(f"[recon-wire] FAILED: {type(e).__name__}: {e}\n")

        # #2 MANIFOLD CANONICALIZATION (gated SINAIN_MANIFOLD_CANON, default OFF). Runs LAST
        # (after recon) so it sees the final fact set; kind=recon facts are skipped (kept
        # distinct). Collapses paraphrase clusters to their spherical medoid (soft-retract
        # the rest) for run-to-run semantic stability. Fail-open. Bakes into the cached store.
        if os.environ.get("SINAIN_MANIFOLD_CANON") == "1":
            try:
                import knowledge_integrator
                _r = knowledge_integrator._manifold_canonicalize_graph(
                    str(mem_dir / "knowledge-graph.db"))
                sys.stderr.write(f"[manifold-wire] soft-retracted {_r} paraphrase fact(s)\n")
            except Exception as e:
                sys.stderr.write(f"[manifold-wire] FAILED: {type(e).__name__}: {e}\n")

        # #1 SURPRISAL SALIENCE PRUNE (gated SINAIN_SURPRISAL_SALIENCE, default OFF). Graph-wide
        # post-pass (needs the full user manifold). Soft-retracts low-information world-trivia.
        # Runs after recon+manifold; skips recon/verbatim. Fail-open. Bakes into the cached store.
        if os.environ.get("SINAIN_SURPRISAL_SALIENCE") == "1":
            try:
                import knowledge_integrator as _ki
                _lr = float(os.environ.get("SINAIN_SALIENCE_LR_THETA", "0.0"))
                _gf = float(os.environ.get("SINAIN_SALIENCE_GFLOOR", "0.0"))
                _p = _ki._surprisal_prune_graph(str(mem_dir / "knowledge-graph.db"), _lr, _gf)
                sys.stderr.write(f"[surprisal-wire] pruned {_p} low-information fact(s)\n")
            except Exception as e:
                sys.stderr.write(f"[surprisal-wire] FAILED: {type(e).__name__}: {e}\n")

        # #6 COVERAGE GAP-FILL (gated SINAIN_GAPFILL, default OFF). Runs LAST so it fills
        # against the final fact set; emits kind=gapfill (exempt from #1/#2). Bakes uncovered,
        # anchor-bearing source sentences as first-class facts. Fail-open.
        if os.environ.get("SINAIN_GAPFILL") == "1":
            try:
                import knowledge_integrator as _ki
                _g = _ki._coverage_gapfill_graph(str(mem_dir / "knowledge-graph.db"))
                sys.stderr.write(f"[gapfill-wire] added {_g} coverage gap-fill fact(s)\n")
            except Exception as e:
                sys.stderr.write(f"[gapfill-wire] FAILED: {type(e).__name__}: {e}\n")

        # #6b ONLINE RECURRENCE IMPORTANCE (gated SINAIN_RECURRENCE, default OFF). Scores each
        # fact by forward cross-chunk recurrence (writes `recurrence`); SINAIN_RECURRENCE_DROP=1
        # also soft-retracts the isolated one-off volatile tail. Fail-open.
        if os.environ.get("SINAIN_RECURRENCE") == "1":
            try:
                import knowledge_integrator as _ki
                _drop = os.environ.get("SINAIN_RECURRENCE_DROP") == "1"
                _w = _ki._recurrence_importance_graph(str(mem_dir / "knowledge-graph.db"),
                                                      drop_isolated=_drop)
                sys.stderr.write(f"[recurrence-wire] scored {_w} fact(s)\n")
            except Exception as e:
                sys.stderr.write(f"[recurrence-wire] FAILED: {type(e).__name__}: {e}\n")

        # Copy the resulting Oxigraph store directory to cache.
        # rdf_store persists as a directory (Oxigraph RocksDB tree), not a
        # single file — copytree replaces the file-based copy from the
        # SQLite era. db_path keeps the .db suffix for path parity with the
        # historical layout; pyoxigraph treats it as a regular directory.
        db_path = mem_dir / "knowledge-graph.db"
        if db_path.is_dir() and any(db_path.iterdir()):
            if cache_path.exists():
                shutil.rmtree(cache_path, ignore_errors=True)
            shutil.copytree(db_path, cache_path)
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
