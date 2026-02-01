#!/usr/bin/env node
/**
 * LLM-as-Judge for HUD line quality.
 * Reads hud-examples.jsonl, scores each HUD line on accuracy/conciseness/specificity.
 * Outputs JSON results to stdout.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'google/gemini-2.5-flash';

if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY not set');
  process.exit(1);
}

function loadDataset(path) {
  const raw = readFileSync(path, 'utf-8');
  return raw.trim().split('\n').map(line => JSON.parse(line));
}

async function judgeHud(example) {
  const { context, hud, expected_hud } = example;

  const prompt = `You are evaluating HUD overlay text quality for a real-time activity monitor.

Given the screen/audio context below, rate the HUD line on three criteria.

## Context
${JSON.stringify(context, null, 2)}

## HUD Line to Evaluate
"${hud}"

${expected_hud ? `## Reference (expected)
"${expected_hud}"` : ''}

## Scoring Rubric
Rate each on 1-4:
- **Accuracy**: Does it correctly describe what the user is doing? (1=wrong, 4=precise)
- **Conciseness**: Is it within 15 words with no filler? (1=verbose/vague, 4=terse+clear)
- **Specificity**: Does it mention app/file names or specific actions? (1=generic, 4=specific)

Respond ONLY with valid JSON:
{"accuracy":N,"conciseness":N,"specificity":N,"comment":"brief explanation"}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0,
    }),
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  try {
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { accuracy: 0, conciseness: 0, specificity: 0, comment: `parse error: ${raw.slice(0, 100)}` };
  }
}

async function main() {
  const datasetPath = resolve(__dirname, 'datasets/hud-examples.jsonl');
  const examples = loadDataset(datasetPath);
  console.error(`Loaded ${examples.length} examples from ${datasetPath}`);

  const results = [];
  for (const example of examples) {
    const score = await judgeHud(example);
    results.push({ ...example, score });
    console.error(`  [${results.length}/${examples.length}] accuracy=${score.accuracy} conciseness=${score.conciseness} specificity=${score.specificity}`);
  }

  // Summary stats
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const summary = {
    count: results.length,
    avgAccuracy: avg(results.map(r => r.score.accuracy)).toFixed(2),
    avgConciseness: avg(results.map(r => r.score.conciseness)).toFixed(2),
    avgSpecificity: avg(results.map(r => r.score.specificity)).toFixed(2),
    avgOverall: avg(results.map(r => (r.score.accuracy + r.score.conciseness + r.score.specificity) / 3)).toFixed(2),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
