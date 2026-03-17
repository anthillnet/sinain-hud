#!/usr/bin/env bash
# Run all eval suites: sinain-core (TypeScript) + sinain-memory (Python unit tests)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CORE_EXIT=0
KOOG_EXIT=0

echo "=== sinain-core eval ==="
cd "$ROOT/sinain-core"
npm run eval:quick || CORE_EXIT=$?

echo ""
echo "=== sinain-memory unit tests ==="
cd "$ROOT/sinain-hud-plugin/sinain-memory"
python3 -m pytest tests/ -q --tb=short || KOOG_EXIT=$?

echo ""
if [ $CORE_EXIT -ne 0 ] || [ $KOOG_EXIT -ne 0 ]; then
  echo "FAIL: sinain-core=$CORE_EXIT sinain-memory=$KOOG_EXIT"
  exit 1
fi
echo "All suites passed."
