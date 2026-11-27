"""Harness-agnostic bake-off runner. Runs every fixture through one or more adapters,
collects the headline metrics, prints a table, and writes results/<adapter>.json.

Metrics per turn:
  setup_ms              — boot-once warm-up (excluded from per-turn latency)
  ttfc_ms               — time to first CONTENT token (the reasoning-model-correct metric)
  final_ms              — time to `done`
  tool_calls            — which tools were actually invoked
  tool_quality          — did it use any expected tool? (pass/fail/n-a)

Usage:
  python runner.py                      # all implemented adapters, all fixtures
  python runner.py --adapter baseline   # one adapter
  python runner.py --fixture memory     # one fixture
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from adapters import ALL, get_adapter
from contract import ChatContext
from fixtures import FIXTURES


def _load_env() -> None:
    env = Path(__file__).parent / ".env"
    if env.exists():
        for ln in env.read_text().splitlines():
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                os.environ.setdefault(k, v)


async def run_one(adapter, fx) -> dict:
    ctx = ChatContext(kind="main", seed="")
    t0 = time.perf_counter()
    ttfc = None
    tools_used: list[str] = []
    final_text = ""
    error = None
    try:
        async for ev in adapter.run(fx.prompt, ctx):
            if ev.type == "token" and ttfc is None:
                ttfc = (ev.ts - t0) * 1000
            elif ev.type == "tool_call":
                tools_used.append(ev.tool_name)
            elif ev.type == "done":
                final_text = ev.text
            elif ev.type == "error":
                error = ev.text
    except Exception as e:  # noqa: BLE001 — adapter robustness varies; capture it
        error = f"{type(e).__name__}: {e}"
    final_ms = (time.perf_counter() - t0) * 1000

    if not fx.expected_tools:
        quality = "n/a"
    else:
        quality = "pass" if any(t in tools_used for t in fx.expected_tools) else "FAIL"
    return {"fixture": fx.id, "ttfc_ms": round(ttfc) if ttfc else None,
            "final_ms": round(final_ms), "tools_used": tools_used,
            "expected": fx.expected_tools, "tool_quality": quality,
            "error": error, "reply_preview": (final_text or "")[:120]}


def _median(xs: list) -> int | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return round((xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2))


def _aggregate(runs: list[dict]) -> dict:
    """Collapse N runs of one fixture into a row: median latency + range, majority quality."""
    ttfcs = [r["ttfc_ms"] for r in runs]
    finals = [r["final_ms"] for r in runs]
    qualities = [r["tool_quality"] for r in runs]
    passes = sum(1 for q in qualities if q == "pass")
    fails = sum(1 for q in qualities if q == "FAIL")
    quality = "n/a" if qualities[0] == "n/a" else ("pass" if passes >= fails and passes > 0 else "FAIL")
    errs = [r["error"] for r in runs if r["error"]]
    return {"fixture": runs[0]["fixture"], "n": len(runs),
            "ttfc_med": _median(ttfcs), "ttfc_min": _median([min(x for x in ttfcs if x is not None)]) if any(ttfcs) else None,
            "final_med": _median(finals),
            "final_min": min(finals) if finals else None, "final_max": max(finals) if finals else None,
            "tool_quality": quality, "errors": len(errs),
            "reply_preview": runs[0]["reply_preview"]}


async def run_adapter(name: str, fixtures, runs: int = 3) -> dict:
    adapter = get_adapter(name)
    t0 = time.perf_counter()
    await adapter.setup()
    setup_ms = round((time.perf_counter() - t0) * 1000)
    rows = []
    for fx in fixtures:
        fx_runs = [await run_one(adapter, fx) for _ in range(runs)]
        rows.append(_aggregate(fx_runs))
    await adapter.teardown()
    return {"adapter": name, "setup_ms": setup_ms, "runs": runs,
            "model": os.environ.get("BENCH_MODEL"), "rows": rows}


def _print(result: dict) -> None:
    print(f"\n=== {result['adapter']}  (setup {result['setup_ms']}ms, n={result.get('runs')} runs, model {result['model']}) ===")
    print(f"{'fixture':<16}{'ttfc_med':>10}{'final_med':>11}{'final_rng':>16}  {'quality':<7} err")
    for r in result["rows"]:
        ttfc = r["ttfc_med"] if r["ttfc_med"] is not None else "-"
        rng = f"[{r['final_min']}-{r['final_max']}]" if r["final_min"] is not None else "-"
        print(f"{r['fixture']:<16}{str(ttfc):>10}{str(r['final_med']):>11}{rng:>16}  {r['tool_quality']:<7} {r['errors']}")


async def main() -> None:
    _load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", action="append", help="adapter name(s); default = all implemented")
    ap.add_argument("--fixture", help="run only this fixture id")
    ap.add_argument("--runs", type=int, default=3, help="runs per fixture (median; variance is high)")
    args = ap.parse_args()

    fixtures = [f for f in FIXTURES if not args.fixture or f.id == args.fixture]
    names = args.adapter or ["baseline"]  # default to the only guaranteed-runnable one
    if names == ["all"]:
        names = ALL

    Path(Path(__file__).parent / "results").mkdir(exist_ok=True)
    for name in names:
        try:
            result = await run_adapter(name, fixtures, runs=args.runs)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {name}: SETUP FAILED — {type(e).__name__}: {e}")
            continue
        _print(result)
        out = Path(__file__).parent / "results" / f"{name}.json"
        out.write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
