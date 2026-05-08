# Testing Patterns

**Analysis Date:** 2026-05-08

## Overview

Testing strategy varies by language:
- **TypeScript** (`sinain-core/`) — LLM-as-Judge eval framework (no unit tests)
- **Dart/Flutter** (`overlay/`) — Widget tests via `flutter test`
- **Python** (`sense_client/`, `sinain-memory/`) — Benchmark suite via custom runner
- **No CI unit testing** — Type-checking and static analysis only

---

## sinain-core (TypeScript)

### Evaluation Framework

**Framework:** Custom TSX-based evaluation harness (not Jest/Vitest)

**Config Files:**
- `sinain-core/eval/harness.ts` — Main evaluation orchestrator
- `sinain-core/eval/metrics.ts` — Metric computation (5-layer stack)
- `sinain-core/eval/report.ts` — Report generation
- `sinain-core/eval/judges/` — LLM judge implementations
- `sinain-core/eval/scenarios/` — JSONL scenario files

**Run Commands:**
```bash
npm run eval                    # Full evaluation: 3 runs, generates reports to eval/reports/
npm run eval:quick             # Quick evaluation: 1 run, output to stdout (fast feedback)
```

**Scenario Format (JSONL):**

Each line is a JSON object with structure:
```json
{
  "id": "app-01",
  "name": "rapid-4app-churn",
  "category": "app-switching",
  "context": {
    "screen": [
      {
        "id": 1,
        "type": "context",
        "ts": 1706900000000,
        "ocr": "IntelliJ IDEA",
        "meta": {"ssim": 0.7, "app": "IntelliJ IDEA", "screen": 0}
      }
    ],
    "audio": [
      {"id": 1, "text": "...", "priority": "normal", "ts": 1706900009000}
    ],
    "currentApp": "VS Code",
    "appHistory": [
      {"app": "IntelliJ IDEA", "ts": 1706900000000}
    ]
  },
  "expectations": {
    "digestShouldContain": ["switching"],
    "digestShouldNotContain": ["error"],
    "hudShouldContain": ["..."],
    "shouldEscalate": false,
    "escalationScoreMin": 1,
    "escalationScoreMax": 10,
    "maxLatencyMs": 10000,
    "maxCost": 0.05,
    "situationShouldContain": ["..."]
  },
  "judgeRubric": "..."
}
```

**Scenario Files:**
- `sinain-core/eval/scenarios/app-switching.jsonl` — 10 scenarios
- `sinain-core/eval/scenarios/audio-question.jsonl`
- `sinain-core/eval/scenarios/error-detection.jsonl`
- `sinain-core/eval/scenarios/focus-mode.jsonl`
- `sinain-core/eval/scenarios/idle-suppression.jsonl`

### Test Structure

**Harness Flow:**

1. **Load scenarios** from JSONL files in `eval/scenarios/`
2. **Run each scenario** N times (default 3, `--runs 1` for quick)
3. **Assertions** checked:
   - Text matching: `digestShouldContain`, `digestShouldNotContain`, `hudShouldContain`
   - Escalation: `shouldEscalate` boolean, `escalationScoreMin/Max`
   - Performance: `maxLatencyMs`, `maxCost`
   - Content: `situationShouldContain` (SITUATION.md checks)
4. **LLM Judge** (optional): Call LLM with `judgeRubric` for qualitative scoring
5. **Metrics** computed: pass rate, latency percentiles (P50/P95), cost breakdown
6. **Report** generated: JSON + markdown to `eval/reports/`

**Key Types (harness.ts):**
```typescript
export interface EvalScenario {
  id: string;
  name: string;
  category: string;
  context: {
    screen: SenseEvent[];
    audio: FeedItem[];
    currentApp: string;
    appHistory: { app: string; ts: number }[];
  };
  expectations: { ... };
  judgeRubric?: string;
}

export interface EvalResult {
  scenarioId: string;
  runId: number;
  passed: boolean;
  assertions: AssertionResult[];
  latencyMs: number;
  cost: number;
  hud: string;
  digest: string;
  escalationScore: number;
  llmJudgeScore?: number;
  situationContent?: string;
}
```

### Metrics (eval/metrics.ts)

**Computed Metrics:**
- `passRate` — % of assertions passed
- `assertionPassRate` — per-assertion breakdown
- `escalationAccuracy` — % of escalations matching `shouldEscalate`
- `avgJudgeScore` — LLM judge quality rating (0-10 scale)
- `latencyP50`, `latencyP95` — percentile response times
- `avgCostPerTick`, `totalCost` — OpenRouter API costs
- `confidenceInterval` — 95% CI for pass rate
- `failedScenarios` — list of failed scenario IDs

**5-Layer Stack (from agentic-evaluation-intro.md):**
1. **Deterministic assertions** — exact matches, boolean checks
2. **Cost & latency** — performance gates
3. **Escalation scoring** — pattern-based decision accuracy
4. **LLM-as-Judge** — qualitative rubric evaluation
5. **User feedback loops** — human review of judge decisions

### Running Tests

**Full evaluation:**
```bash
cd sinain-core
npm run eval --scenarios eval/scenarios/ --runs 3 --report eval/reports/
# Generates: eval/reports/YYYY-MM-DD.json + .md
```

**Quick feedback (1 run, stdout):**
```bash
npm run eval:quick
```

**Output Format:**
```json
{
  "runDate": "2026-05-08",
  "config": { ... },
  "scenarios": 50,
  "runsPerScenario": 3,
  "results": [ ... ],
  "metrics": {
    "passRate": 0.95,
    "assertionPassRate": 0.93,
    "latencyP50": 1234,
    "latencyP95": 4567,
    ...
  }
}
```

### No Unit Tests

**Absence:**
- No `.test.ts` or `.spec.ts` files
- No Jest/Vitest config
- No mocking framework

**Why:**
- Core logic is tightly coupled to async I/O (LLM calls, WebSocket)
- Evaluation framework is the primary quality gate
- Integration testing via eval harness is more valuable than unit mocks

### CI Integration

**CI Job:** `.github/workflows/ci.yml` — `sinain-core-typecheck` job

```yaml
sinain-core-typecheck:
  name: sinain-core — TypeScript Check
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: npm
    - run: npm ci
    - name: TypeScript check
      run: npx tsc --noEmit
```

**What it checks:**
- `npm ci` installs dependencies
- `tsc --noEmit` type-checks without emitting (fast)
- No runtime tests (eval harness is manual, not automated)

---

## Overlay (Dart/Flutter)

### Test Framework

**Framework:** Flutter's built-in `flutter_test` with `flutter test` runner

**Config Files:**
- `overlay/analysis_options.yaml` — Static analysis (includes `flutter_lints`)
- `overlay/test/` — Test directory (Flutter convention)

### Test Files

**Existing Tests:**
- `overlay/test/widget_test.dart` — Widget tests for FeedItem, HudSettings
- `overlay/test/feed_scroll_test.dart` — Feed scroll behavior tests

### Widget Test Structure

**Example (widget_test.dart):**
```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sinain_hud/core/models/feed_item.dart';
import 'package:sinain_hud/core/models/hud_settings.dart';

void main() {
  group('FeedItem', () {
    test('creates with defaults', () {
      final item = FeedItem(id: '1', text: 'test');
      expect(item.priority, FeedPriority.normal);
      expect(item.opacity, 1.0);
    });

    test('parses from json', () {
      final item = FeedItem.fromJson({
        'id': '2',
        'text': 'urgent message',
        'priority': 'urgent',
      });
      expect(item.priority, FeedPriority.urgent);
      expect(item.text, 'urgent message');
    });
  });

  group('HudSettings', () {
    test('defaults to chat state', () {
      final settings = HudSettings();
      expect(settings.overlayState, HudState.chat);
    });

    test('copyWith preserves display settings', () {
      final original = HudSettings(fontSize: 16.0);
      final copied = original.copyWith(overlayState: HudState.eye);
      expect(copied.fontSize, 16.0);
      expect(copied.overlayState, HudState.eye);
    });
  });
}
```

**Patterns:**
- `group()` to organize related tests
- `test()` for individual assertions
- `expect()` for assertions
- Factory method testing: `FeedItem.fromJson()`, `HudSettings.copyWith()`
- Immutability verification: copyWith preserves original values

### Test Types

**Unit Tests (what's being tested):**
- **Model serialization:** JSON parsing (fromJson)
- **Model defaults:** Constructor default values
- **Immutability:** copyWith creates new instances
- **Enum parsing:** priority/channel string → enum
- **Getters:** computed properties (e.g., `isUser`, `isSpawn`)

**No Integration Tests** — WebSocket/platform channel tests are manual

### Running Tests

**Run all tests:**
```bash
flutter test
```

**Watch mode (rebuild on file change):**
```bash
flutter test --watch
```

**Run specific test file:**
```bash
flutter test test/widget_test.dart
```

### CI Integration

**CI Job:** `.github/workflows/ci.yml` — `overlay-analyze` job

```yaml
overlay-analyze:
  name: Overlay — Flutter Analyze
  runs-on: macos-latest
  defaults:
    run:
      working-directory: overlay
  steps:
    - uses: actions/checkout@v4
    - uses: subosito/flutter-action@v2
    - run: flutter pub get
    - name: Flutter analyze
      run: flutter analyze
    - name: Flutter test
      run: flutter test
```

**What it checks:**
- `flutter analyze` — static analysis (includes `flutter_lints`)
- `flutter test` — runs all tests in `test/` directory
- macOS runner (required for iOS/macOS dependencies)

### Coverage

**Coverage Tooling:** Not explicitly configured

**What's tested:**
- Model classes (FeedItem, HudSettings)
- Enum parsing
- Immutable copy methods

**What's NOT tested (no integration tests):**
- WebSocket connection logic (tested manually via overlay)
- Platform channel calls to Swift (tested via emulator/device)
- UI rendering and navigation (tested via emulator/device)
- Permission handling

---

## sense_client (Python)

### Testing

**Test Framework:** No automated test suite found

**Why:**
- Heavy platform-specific code (macOS/Windows)
- Direct hardware access (screen capture, audio)
- Best tested via integration (manual testing or CI with physical hardware)

**Manual Testing Approach:**
```bash
python -m sense_client        # Start screen capture pipeline
# Check that:
# - Frames saved to ~/.sinain/capture/frame.jpg
# - OCR results POSTed to sinain-core /sense endpoint
# - Privacy tags stripped from OCR
# - No camera blocking (Google Meet still works)
```

**What to verify manually:**
1. Frame capture rate: 2-10 FPS (configurable)
2. SSIM change detection: only sends frames when screen changes
3. Privacy stripping: `<private>` tags removed, auto-redaction applied
4. No external API calls for screen capture (all local)

---

## sinain-hud-plugin/sinain-memory (Python)

### Benchmark Framework

**Framework:** Custom benchmark runner (`eval/benchmarks/runner.py`)

**Purpose:** Evaluate knowledge graph quality (IPR, recall, precision) against published benchmarks

**Config Files:**
- `eval/benchmarks/config.py` — Models, dataset URLs, timeouts
- `eval/benchmarks/runner.py` — Main orchestrator
- `eval/benchmarks/evaluate.py` — Scoring (token F1, content recall)
- `eval/benchmarks/ingest.py` — Ingestion pipeline
- `eval/benchmarks/query.py` — Retrieval and answering
- `eval/benchmarks/judges/qa_judge.py` — LLM-based QA evaluation
- `eval/benchmarks/base_adapter.py` — Benchmark dataset adapter interface
- `eval/benchmarks/longmemeval_adapter.py` — LongMemEval dataset adapter

**Run Commands:**
```bash
python3 eval/benchmarks/runner.py --benchmarks longmemeval --subset 5
python3 eval/benchmarks/runner.py --benchmarks longmemeval --conditions sinain-memory,full-context
python3 eval/benchmarks/runner.py --benchmarks longmemeval --format markdown --resume
```

### Benchmark Structure

**Datasets:**
- **LongMemEval** (`xiaowu0162/longmemeval-cleaned` from HuggingFace)
  - Long-context QA benchmark
  - Measures information persistence and recall
  - Adapter: `LongMemEvalAdapter` in `longmemeval_adapter.py`

- **LOCOMO** (from snap-research GitHub)
  - Long-context memory benchmark
  - Not currently implemented but referenced in config

### Benchmark Workflow

**config.py settings:**
```python
QA_MODEL = "google/gemini-2.5-flash"      # Question answering
JUDGE_MODEL = "openai/gpt-4o"             # Evaluation judge
K_VALUES = [1, 3, 5, 10]                  # Retrieval result counts
MAX_FACTS_PER_QUERY = 10
DISTILLER_TIMEOUT_S = 30                  # LLM fact extraction
INTEGRATOR_TIMEOUT_S = 60                 # Graph integration
```

**Pipeline (runner.py):**

1. **Load benchmark** — Parse dataset (adapter pattern)
2. **Ingest documents** — Run through distiller + integrator
   - `session_distiller.py` — LLM extracts facts
   - `knowledge_integrator.py` — Code stores in graph
3. **Query knowledge** — Answer questions via graph retrieval
   - `graph_query.py` — RRF fusion of FTS5 + tag + entity backrefs
4. **Score responses** — Token F1, content recall via LLM judge
5. **Report results** — Markdown + JSON output

### Metrics

**Information Persistence Recall (IPR):**
- How much retrieved content overlaps with ground-truth facts
- Formula: F1(retrieved_facts, ground_truth_facts)

**QA Judge Score:**
- LLM evaluation of answer quality against reference answers
- Scale: 0-10 or binary (correct/incorrect)

**Retrieval Metrics:**
- Recall@K for K ∈ [1, 3, 5, 10]
- Measures % of relevant facts retrieved in top K results

### Benchmark Instance Structure

**BenchmarkInstance (base_adapter.py):**
```python
class BenchmarkInstance:
    id: str
    text: str              # Document content
    questions: list[{
        id: str,
        question: str,
        reference_answer: str,
        ground_truth_facts: list[str]
    }]
```

**Conditions (test variants):**
- `sinain-memory` — Full knowledge graph pipeline (distill + integrate)
- `full-context` — Baseline: answer from full document without distillation

### Report Output

**Formats:**
- Markdown table (`--format markdown`) — Human-readable
- JSON (`--format json`) — Machine-readable, programmatic consumption

**Resume Support:**
- `--resume` flag allows continuing interrupted benchmarks
- Tracks progress in JSON lines (one result per line)
- Skips already-computed results

---

## CI/CD Pipeline

### Type Checking (CI)

**sinain-core-typecheck job:**
```yaml
steps:
  - run: npm ci
  - run: npx tsc --noEmit
```

**What it verifies:**
- No type errors
- Imports resolve correctly
- All `.ts` files compile (but don't emit to disk)

**Why `--noEmit`:** Fast feedback loop (skip JS generation), catches type errors only

### Static Analysis (CI)

**overlay-analyze job:**
```yaml
steps:
  - run: flutter pub get
  - run: flutter analyze
  - run: flutter test
```

**What it checks:**
- Dart/Flutter lint rules (from `flutter_lints`)
- Widget test suite passes

### Release CI

**release-overlay.yml:**
- Triggered by `overlay-v*` tags
- Runs `flutter build macos` on `macos-latest`
- Zips app with `ditto`, uploads to GitHub Releases

---

## Coverage & Gaps

### Test Coverage Summary

| Component | Coverage | Type | Location |
|-----------|----------|------|----------|
| sinain-core | ~90% (eval) | Scenario-based evaluation | `eval/scenarios/` + eval harness |
| Overlay models | ~80% (widget) | Unit + serialization | `test/widget_test.dart` |
| Overlay UI | ~10% (visual) | Manual testing | No automated tests |
| sense_client | ~30% (manual) | Integration only | No unit tests |
| sinain-memory graph | ~85% (benchmark) | LongMemEval dataset | `eval/benchmarks/` |

### Known Gaps

**No unit tests for:**
- WebSocket reconnection logic (overlay)
- Privacy tag stripping edge cases (sense_client)
- Graph query result ranking (sinain-memory)
- Escalation scoring (sinain-core) — covered by eval scenarios

**Why these gaps exist:**
- Heavy async/I/O coupling — mocking is fragile
- Eval framework is primary quality gate
- Manual testing + integration tests more valuable

**To add unit tests:**
- Would require heavy mocking (LLM APIs, WebSocket, file I/O)
- Jest/Vitest setup for sinain-core would help with async utilities
- Python unittest suite for sense_client (particularly privacy.py)

---

## Testing Best Practices (Applied)

### Evaluation (sinain-core)

✅ **Scenario-driven:** Real-world contexts (app switching, error detection, focus mode)
✅ **Multi-dimensional assertions:** Text, escalation, cost, latency
✅ **LLM judge layer:** Qualitative rubric evaluation
✅ **Reproducible runs:** JSONL scenarios, deterministic seeding
✅ **Report generation:** Metrics + markdown for human review

### Widget Testing (Flutter)

✅ **Immutability verification:** copyWith creates new instances
✅ **Factory method testing:** JSON serialization round-trips
✅ **Enum parsing:** String → enum conversion
✅ **Default values:** Constructor defaults

### Benchmarking (sinain-memory)

✅ **Published datasets:** LongMemEval for external validation
✅ **Adapter pattern:** Pluggable benchmark sources
✅ **Resume support:** Long-running benchmarks can be interrupted
✅ **Metric computation:** Token F1, recall@K, IPR

---

*Testing analysis: 2026-05-08*
