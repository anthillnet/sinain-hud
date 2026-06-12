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
# 20 (was 10): the recall@10 *metric* is fixed at 10, but QA accuracy isn't — a
# gold fact that imperfect ranking placed at rank 11-20 never entered the prompt
# at max_facts=10. Diagnostic (2026-05-30) showed gold-keyword density jumps from
# top-10 to top-50 on several r@10=0 fails (89527b6b 25→50%, 06878be2 42→79%,
# 75832dbd 22→66%, gpt4_59149c77 50→67%) → the fact exists, it just wasn't shown.
# Compact one-line facts dilute QA far less than verbose excerpts, so widening the
# window is safe. The fact budget in _query_knowledge is widened to match.
MAX_FACTS_PER_QUERY = 20

# Ingestion
DISTILLER_TIMEOUT_S = 30
INTEGRATOR_TIMEOUT_S = 60

# Dataset URLs
LONGMEMEVAL_HF = "xiaowu0162/longmemeval-cleaned"
LOCOMO_GITHUB = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
