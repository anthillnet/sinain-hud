#!/usr/bin/env node
/**
 * LLM-as-Judge for digest quality.
 * Reads digest-examples.jsonl, scores each digest on completeness/accuracy/actionability/objectivity.
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

async function judgeDigest(example) {
  const { context, digest, expected_digest } = example;

  const prompt = `You are evaluating digest text quality for a real-time activity monitor.

Given the screen/audio context below, rate the digest on four criteria.

## Context
${JSON.stringify(context, null, 2)}

## Digest to Evaluate
"${digest}"

${expected_digest ? `## Reference (expected)
"${expected_digest}"` : ''}

## Scoring Rubric
Rate each on 1-4:
- **Completeness**: Does it capture all visible context (OCR text, audio, app)? (1=missing most, 4=thorough)
- **Factual accuracy**: Does it match what's in the OCR/audio data? (1=hallucinated, 4=precise)
- **Actionability**: Would an AI assistant understand the situation well enough to help? (1=useless, 4=clear situation)
- **Objectivity**: Does it describe without suggesting actions? (1=prescriptive, 4=purely descriptive)

Respond ONLY with valid JSON:
{"completeness":N,"accuracy":N,"actionability":N,"objectivity":N,"comment":"brief explanation"}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0,
    }),
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  try {
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { completeness: 0, accuracy: 0, actionability: 0, objectivity: 0, comment: `parse error: ${raw.slice(0, 100)}` };
  }
}

async function main() {
  const datasetPath = resolve(__dirname, 'datasets/digest-examples.jsonl');
  const examples = loadDataset(datasetPath);
  console.error(`Loaded ${examples.length} examples from ${datasetPath}`);

  const results = [];
  for (const example of examples) {
    const score = await judgeDigest(example);
    results.push({ ...example, score });
    console.error(`  [${results.length}/${examples.length}] completeness=${score.completeness} accuracy=${score.accuracy} actionability=${score.actionability} objectivity=${score.objectivity}`);
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const summary = {
    count: results.length,
    avgCompleteness: avg(results.map(r => r.score.completeness)).toFixed(2),
    avgAccuracy: avg(results.map(r => r.score.accuracy)).toFixed(2),
    avgActionability: avg(results.map(r => r.score.actionability)).toFixed(2),
    avgObjectivity: avg(results.map(r => r.score.objectivity)).toFixed(2),
    avgOverall: avg(results.map(r => (r.score.completeness + r.score.accuracy + r.score.actionability + r.score.objectivity) / 4)).toFixed(2),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
