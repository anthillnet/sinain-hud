"""Benchmark configuration — models, paths, thresholds."""

from pathlib import Path

BENCHMARKS_DIR = Path(__file__).resolve().parent
DATA_DIR = BENCHMARKS_DIR / "data"
RESULTS_DIR = BENCHMARKS_DIR / "results"

# LLM models (via OpenRouter)
QA_MODEL = "google/gemini-2.5-flash"
# Judge swapped from openai/gpt-4o → deepseek/deepseek-v4-flash on 2026-05-18
# for dev iteration cost. Invalidates direct comparison vs runs using the old
# judge per BLOCKING CONSTRAINT 2 — re-baseline future runs against the new
# stack. Both judges are text-only (used by judge_qa); bench_vision keeps a
# separate vision-capable judge constant for image input.
JUDGE_MODEL = "deepseek/deepseek-v4-flash"

# Retrieval
K_VALUES = [1, 3, 5, 10]
MAX_FACTS_PER_QUERY = 10

# Ingestion
DISTILLER_TIMEOUT_S = 30
INTEGRATOR_TIMEOUT_S = 60

# Dataset URLs
LONGMEMEVAL_HF = "xiaowu0162/longmemeval-cleaned"
LOCOMO_GITHUB = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
