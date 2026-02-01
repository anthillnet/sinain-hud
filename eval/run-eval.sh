#!/usr/bin/env bash
# Run all evaluation judges and print summary table.
# Usage: OPENROUTER_API_KEY=sk-... ./eval/run-eval.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== SinainHUD Evaluation Suite ==="
echo ""

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "Error: OPENROUTER_API_KEY not set"
  exit 1
fi

echo "--- HUD Quality (judge-hud.mjs) ---"
HUD_RESULT=$(node "$DIR/judge-hud.mjs" 2>/dev/null)
HUD_SUMMARY=$(echo "$HUD_RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  const s = d.summary;
  console.log('  Examples:     ' + s.count);
  console.log('  Accuracy:     ' + s.avgAccuracy + '/4.00');
  console.log('  Conciseness:  ' + s.avgConciseness + '/4.00');
  console.log('  Specificity:  ' + s.avgSpecificity + '/4.00');
  console.log('  Overall:      ' + s.avgOverall + '/4.00');
")
echo "$HUD_SUMMARY"
echo ""

echo "--- Digest Quality (judge-digest.mjs) ---"
DIGEST_RESULT=$(node "$DIR/judge-digest.mjs" 2>/dev/null)
DIGEST_SUMMARY=$(echo "$DIGEST_RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  const s = d.summary;
  console.log('  Examples:      ' + s.count);
  console.log('  Completeness:  ' + s.avgCompleteness + '/4.00');
  console.log('  Accuracy:      ' + s.avgAccuracy + '/4.00');
  console.log('  Actionability: ' + s.avgActionability + '/4.00');
  console.log('  Objectivity:   ' + s.avgObjectivity + '/4.00');
  console.log('  Overall:       ' + s.avgOverall + '/4.00');
")
echo "$DIGEST_SUMMARY"
echo ""

echo "--- Raw Results ---"
echo "HUD:"
echo "$HUD_RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  d.results.forEach((r, i) => {
    console.log('  ' + (i+1) + '. [' + r.score.accuracy + '/' + r.score.conciseness + '/' + r.score.specificity + '] ' + r.hud);
  });
"
echo ""
echo "Digest:"
echo "$DIGEST_RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  d.results.forEach((r, i) => {
    console.log('  ' + (i+1) + '. [' + r.score.completeness + '/' + r.score.accuracy + '/' + r.score.actionability + '/' + r.score.objectivity + '] ' + r.digest.slice(0, 80) + '...');
  });
"

echo ""
echo "=== Done ==="
