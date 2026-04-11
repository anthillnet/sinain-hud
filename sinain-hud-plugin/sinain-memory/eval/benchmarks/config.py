"""Benchmark configuration — models, paths, thresholds."""

from pathlib import Path

BENCHMARKS_DIR = Path(__file__).resolve().parent
DATA_DIR = BENCHMARKS_DIR / "data"
RESULTS_DIR = BENCHMARKS_DIR / "results"

# LLM models (via OpenRouter)
QA_MODEL = "google/gemini-2.5-flash"
JUDGE_MODEL = "openai/gpt-4o"

# Retrieval
K_VALUES = [1, 3, 5, 10]
MAX_FACTS_PER_QUERY = 10

# Ingestion
DISTILLER_TIMEOUT_S = 30
INTEGRATOR_TIMEOUT_S = 60

# Dataset URLs
LONGMEMEVAL_HF = "xiaowu0162/longmemeval-cleaned"
LOCOMO_GITHUB = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
