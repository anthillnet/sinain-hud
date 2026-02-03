import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeContext } from "../src/agent/analyzer.js";
import { calculateEscalationScore, ESCALATION_THRESHOLD } from "../src/escalation/scorer.js";
import type { AgentConfig, ContextWindow, FeedItem, SenseEvent, ContextRichness } from "../src/types.js";
import { RICHNESS_PRESETS } from "../src/agent/context-window.js";
import { computeMetrics } from "./metrics.js";
import { generateReport } from "./report.js";

// ── Types ──

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
  expectations: {
    digestShouldContain?: string[];
    digestShouldNotContain?: string[];
    hudShouldContain?: string[];
    shouldEscalate: boolean;
    escalationScoreMin?: number;
    escalationScoreMax?: number;
    maxLatencyMs?: number;
    maxCost?: number;
  };
  judgeRubric?: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
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
}

export interface EvalReport {
  runDate: string;
  config: Record<string, unknown>;
  scenarios: number;
  runsPerScenario: number;
  results: EvalResult[];
  metrics: ReturnType<typeof computeMetrics>;
}

// ── Scenario loader ──

function loadScenarios(dir: string): EvalScenario[] {
  const scenarios: EvalScenario[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        scenarios.push(JSON.parse(line));
      } catch {
        console.warn(`[eval] skipping invalid JSON in ${file}: ${line.slice(0, 80)}`);
      }
    }
  }

  return scenarios;
}

// ── Assertion checker ──

function checkAssertions(
  scenario: EvalScenario,
  hud: string,
  digest: string,
  escalationScore: number,
  shouldEscalate: boolean,
  latencyMs: number,
  cost: number,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const exp = scenario.expectations;

  if (exp.digestShouldContain) {
    for (const keyword of exp.digestShouldContain) {
      results.push({
        name: `digest contains "${keyword}"`,
        passed: digest.toLowerCase().includes(keyword.toLowerCase()),
        expected: keyword,
        actual: digest.slice(0, 200),
      });
    }
  }

  if (exp.digestShouldNotContain) {
    for (const keyword of exp.digestShouldNotContain) {
      results.push({
        name: `digest does not contain "${keyword}"`,
        passed: !digest.toLowerCase().includes(keyword.toLowerCase()),
        expected: `NOT ${keyword}`,
        actual: digest.slice(0, 200),
      });
    }
  }

  if (exp.hudShouldContain) {
    for (const keyword of exp.hudShouldContain) {
      results.push({
        name: `hud contains "${keyword}"`,
        passed: hud.toLowerCase().includes(keyword.toLowerCase()),
        expected: keyword,
        actual: hud,
      });
    }
  }

  results.push({
    name: "escalation decision",
    passed: shouldEscalate === exp.shouldEscalate,
    expected: String(exp.shouldEscalate),
    actual: String(shouldEscalate),
  });

  if (exp.escalationScoreMin !== undefined) {
    results.push({
      name: `escalation score >= ${exp.escalationScoreMin}`,
      passed: escalationScore >= exp.escalationScoreMin,
      expected: `>= ${exp.escalationScoreMin}`,
      actual: String(escalationScore),
    });
  }

  if (exp.escalationScoreMax !== undefined) {
    results.push({
      name: `escalation score <= ${exp.escalationScoreMax}`,
      passed: escalationScore <= exp.escalationScoreMax,
      expected: `<= ${exp.escalationScoreMax}`,
      actual: String(escalationScore),
    });
  }

  if (exp.maxLatencyMs !== undefined) {
    results.push({
      name: `latency <= ${exp.maxLatencyMs}ms`,
      passed: latencyMs <= exp.maxLatencyMs,
      expected: `<= ${exp.maxLatencyMs}`,
      actual: String(latencyMs),
    });
  }

  if (exp.maxCost !== undefined) {
    results.push({
      name: `cost <= $${exp.maxCost}`,
      passed: cost <= exp.maxCost,
      expected: `<= ${exp.maxCost}`,
      actual: String(cost),
    });
  }

  return results;
}

// ── Run a single scenario ──

async function runScenario(
  scenario: EvalScenario,
  agentConfig: AgentConfig,
  richness: ContextRichness,
  runId: number,
): Promise<EvalResult> {
  const preset = RICHNESS_PRESETS[richness];

  const contextWindow: ContextWindow = {
    audio: scenario.context.audio,
    screen: scenario.context.screen,
    currentApp: scenario.context.currentApp,
    appHistory: scenario.context.appHistory,
    audioCount: scenario.context.audio.length,
    screenCount: scenario.context.screen.length,
    windowMs: 120000,
    newestEventTs: Math.max(
      ...[...scenario.context.audio, ...scenario.context.screen].map(e => e.ts || 0),
      0
    ),
    preset,
  };

  const result = await analyzeContext(contextWindow, agentConfig);
  const score = calculateEscalationScore(result.digest, contextWindow);
  const shouldEscalate = score.total >= ESCALATION_THRESHOLD;

  const costPerToken = { in: 0.075 / 1_000_000, out: 0.3 / 1_000_000 };
  const cost = result.tokensIn * costPerToken.in + result.tokensOut * costPerToken.out;

  const assertions = checkAssertions(
    scenario,
    result.hud,
    result.digest,
    score.total,
    shouldEscalate,
    result.latencyMs,
    cost,
  );

  return {
    scenarioId: scenario.id,
    runId,
    passed: assertions.every(a => a.passed),
    assertions,
    latencyMs: result.latencyMs,
    cost,
    hud: result.hud,
    digest: result.digest,
    escalationScore: score.total,
  };
}

// ── Main harness ──

async function main() {
  const args = process.argv.slice(2);
  const scenariosDir = args.find((a, i) => args[i - 1] === "--scenarios") || "eval/scenarios/";
  const runs = parseInt(args.find((a, i) => args[i - 1] === "--runs") || "1");
  const reportDir = args.find((a, i) => args[i - 1] === "--report") || "eval/reports/";
  const fast = args.includes("--fast");

  console.log(`[eval] Loading scenarios from ${scenariosDir}`);
  const scenarios = loadScenarios(scenariosDir);
  console.log(`[eval] Loaded ${scenarios.length} scenarios, running ${runs}x each`);

  if (scenarios.length === 0) {
    console.log("[eval] No scenarios found. Create .jsonl files in eval/scenarios/");
    process.exit(0);
  }

  const agentConfig: AgentConfig = {
    enabled: true,
    model: process.env.AGENT_MODEL || "google/gemini-2.5-flash-lite",
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    maxTokens: 300,
    temperature: 0.3,
    pushToFeed: false,
    debounceMs: 3000,
    maxIntervalMs: 30000,
    cooldownMs: 10000,
    maxAgeMs: 120000,
    fallbackModels: [],
  };

  if (!agentConfig.openrouterApiKey) {
    console.error("[eval] OPENROUTER_API_KEY not set");
    process.exit(1);
  }

  const results: EvalResult[] = [];

  for (let run = 0; run < runs; run++) {
    for (const scenario of scenarios) {
      try {
        const result = await runScenario(scenario, agentConfig, "standard", run);
        results.push(result);

        const status = result.passed ? "✓" : "✗";
        console.log(`  ${status} ${scenario.id} (run ${run}): ${result.latencyMs}ms, score=${result.escalationScore}`);

        if (!result.passed) {
          for (const a of result.assertions) {
            if (!a.passed) {
              console.log(`    FAIL: ${a.name} (expected=${a.expected}, actual=${a.actual})`);
            }
          }
        }
      } catch (err: any) {
        console.error(`  ✗ ${scenario.id} (run ${run}): ERROR ${err.message}`);
      }
    }
  }

  const metrics = computeMetrics(results, scenarios.length, runs);
  const report: EvalReport = {
    runDate: new Date().toISOString(),
    config: { model: agentConfig.model, richness: "standard" },
    scenarios: scenarios.length,
    runsPerScenario: runs,
    results,
    metrics,
  };

  if (reportDir && reportDir !== "/dev/stdout") {
    mkdirSync(reportDir, { recursive: true });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    writeFileSync(join(reportDir, `${timestamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(reportDir, `${timestamp}.md`), generateReport(report));
    console.log(`\n[eval] Report written to ${reportDir}/${timestamp}.{json,md}`);
  } else {
    console.log("\n" + generateReport(report));
  }
}

main().catch(err => {
  console.error("[eval] Fatal:", err);
  process.exit(1);
});
