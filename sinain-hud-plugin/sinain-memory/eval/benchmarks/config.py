"""Benchmark configuration — models, paths, thresholds."""

from pathlib import Path

BENCHMARKS_DIR = Path(__file__).resolve().parent
DATA_DIR = BENCHMARKS_DIR / "data"
RESULTS_DIR = BENCHMARKS_DIR / "results"

# LLM models (via OpenRouter)
QA_MODEL = "google/gemini-2.5-flash"
# Judge history:
#   2026-05-18: openai/gpt-4o → deepseek/deepseek-v4-flash (cost iteration)
#   2026-05-27: deepseek/deepseek-v4-flash → openai/gpt-4o-2024-08-06
#     Reason: deepseek-v4-flash is a reasoning model; the verbatim LongMemEval
#     paper port uses max_tokens=10 which is consumed entirely by hidden
#     reasoning → empty completions → uniform paper_label=0 (subset n=20 on
#     2026-05-27 returned 0.0% with 12/18 empty responses). gpt-4o-2024-08-06
#     matches the paper + Hindsight reference exactly, lands at comparable
#     per-call cost (~$0.0004/call) for binary judging, and eliminates the
#     D-07 comparability caveat.
JUDGE_MODEL = "openai/gpt-4o-2024-08-06"

# Retrieval
K_VALUES = [1, 3, 5, 10]
MAX_FACTS_PER_QUERY = 10

# Ingestion
DISTILLER_TIMEOUT_S = 30
INTEGRATOR_TIMEOUT_S = 60

# Dataset URLs
LONGMEMEVAL_HF = "xiaowu0162/longmemeval-cleaned"
LOCOMO_GITHUB = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
