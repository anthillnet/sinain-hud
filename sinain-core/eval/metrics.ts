/**
 * Compute aggregate metrics from eval results.
 * Follows the 5-layer evaluation stack from agentic-evaluation-intro.md.
 */

interface EvalResult {
  scenarioId: string;
  runId: number;
  passed: boolean;
  assertions: { name: string; passed: boolean }[];
  latencyMs: number;
  cost: number;
  escalationScore: number;
  llmJudgeScore?: number;
}

export interface EvalMetrics {
  // Test-based
  passRate: number;
  assertionPassRate: number;
  escalationAccuracy: number;

  // Quality (LLM-as-judge)
  avgJudgeScore: number;
  judgeScoreDistribution: number[];

  // Performance
  latencyP50: number;
  latencyP95: number;
  avgCostPerTick: number;
  totalCost: number;

  // Statistical
  confidenceInterval: [number, number];
  runsPerScenario: number;
  totalResults: number;

  // Failures
  failedScenarios: string[];
}

export function computeMetrics(
  results: EvalResult[],
  totalScenarios: number,
  runsPerScenario: number,
): EvalMetrics {
  if (results.length === 0) {
    return {
      passRate: 0,
      assertionPassRate: 0,
      escalationAccuracy: 0,
      avgJudgeScore: 0,
      judgeScoreDistribution: [0, 0, 0, 0],
      latencyP50: 0,
      latencyP95: 0,
      avgCostPerTick: 0,
      totalCost: 0,
      confidenceInterval: [0, 0],
      runsPerScenario,
      totalResults: 0,
      failedScenarios: [],
    };
  }

  // Pass rate: scenarios where ALL runs passed
  const scenarioResults = new Map<string, boolean[]>();
  for (const r of results) {
    if (!scenarioResults.has(r.scenarioId)) {
      scenarioResults.set(r.scenarioId, []);
    }
    scenarioResults.get(r.scenarioId)!.push(r.passed);
  }

  let scenariosPassed = 0;
  const failedScenarios: string[] = [];
  for (const [id, runs] of scenarioResults) {
    // Scenario passes if majority of runs pass
    const passCount = runs.filter(Boolean).length;
    if (passCount > runs.length / 2) {
      scenariosPassed++;
    } else {
      failedScenarios.push(id);
    }
  }
  const passRate = scenariosPassed / scenarioResults.size;

  // Assertion pass rate
  const totalAssertions = results.reduce((sum, r) => sum + r.assertions.length, 0);
  const passedAssertions = results.reduce(
    (sum, r) => sum + r.assertions.filter(a => a.passed).length, 0
  );
  const assertionPassRate = totalAssertions > 0 ? passedAssertions / totalAssertions : 0;

  // Escalation accuracy (for the "escalation decision" assertion specifically)
  const escalationAssertions = results.flatMap(r =>
    r.assertions.filter(a => a.name === "escalation decision")
  );
  const escalationAccuracy = escalationAssertions.length > 0
    ? escalationAssertions.filter(a => a.passed).length / escalationAssertions.length
    : 0;

  // LLM-as-judge scores
  const judgeScores = results
    .map(r => r.llmJudgeScore)
    .filter((s): s is number => s !== undefined && s > 0);
  const avgJudgeScore = judgeScores.length > 0
    ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length
    : 0;

  const judgeScoreDistribution = [0, 0, 0, 0]; // [fail%, partial%, good%, excellent%]
  for (const s of judgeScores) {
    if (s >= 1 && s <= 4) {
      judgeScoreDistribution[s - 1]++;
    }
  }
  if (judgeScores.length > 0) {
    for (let i = 0; i < 4; i++) {
      judgeScoreDistribution[i] = Math.round((judgeScoreDistribution[i] / judgeScores.length) * 100);
    }
  }

  // Latency
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const latencyP50 = latencies[Math.floor(latencies.length / 2)] || 0;
  const latencyP95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  // Cost
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const avgCostPerTick = totalCost / results.length;

  // 95% confidence interval on pass rate (Wilson score)
  const n = results.length;
  const p = passRate;
  const z = 1.96; // 95% CI
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denominator;
  const confidenceInterval: [number, number] = [
    Math.max(0, Math.round((center - halfWidth) * 1000) / 1000),
    Math.min(1, Math.round((center + halfWidth) * 1000) / 1000),
  ];

  return {
    passRate: Math.round(passRate * 1000) / 1000,
    assertionPassRate: Math.round(assertionPassRate * 1000) / 1000,
    escalationAccuracy: Math.round(escalationAccuracy * 1000) / 1000,
    avgJudgeScore: Math.round(avgJudgeScore * 10) / 10,
    judgeScoreDistribution,
    latencyP50: Math.round(latencyP50),
    latencyP95: Math.round(latencyP95),
    avgCostPerTick: Math.round(avgCostPerTick * 1000000) / 1000000,
    totalCost: Math.round(totalCost * 1000000) / 1000000,
    confidenceInterval,
    runsPerScenario,
    totalResults: results.length,
    failedScenarios,
  };
}
