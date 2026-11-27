#!/usr/bin/env bash
# RTA SAST + DAST PoC — preflight smoke test.
#
# Run this ONCE on the demo machine (needs Docker + Node) to prove the whole
# stack works before you present. It runs Parts A/B/C of the guide end-to-end
# and prints PASS/FAIL per stage. TeamCity (Part D) is the manual UI step and is
# not exercised here.
#
# Usage:   scripts/poc-preflight.sh
# From:    the sinain-hud-2 repo root.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

QODANA_PY_IMAGE="jetbrains/qodana-python-community:2026.1"   # bump tag if needed
ZAP_IMAGE="ghcr.io/zaproxy/zaproxy:stable"
PORT=9500
pass=0; fail=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
no(){ echo "  ❌ $1"; fail=$((fail+1)); }
hr(){ echo; echo "── $1 ──"; }

# On Linux, containers reach the host via this gateway alias.
ADD_HOST=(); [ "$(uname)" = "Linux" ] && ADD_HOST=(--add-host=host.docker.internal:host-gateway)

hr "0. Tooling"
command -v docker >/dev/null && ok "docker present ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))" || no "docker missing"
command -v node   >/dev/null && ok "node present ($(node -v))" || no "node missing"
docker info >/dev/null 2>&1 && ok "docker daemon reachable" || no "docker daemon not running"

hr "1. Build sinain-core"
( cd sinain-core && npm ci >/tmp/poc-npm.log 2>&1 && npm run build >>/tmp/poc-npm.log 2>&1 ) \
  && ok "sinain-core built" || { no "build failed (see /tmp/poc-npm.log)"; }

hr "2. SAST — Qodana (Python Community, free)"
mkdir -p qodana-out/python
docker run --rm \
  -v "$REPO/sense_client":/data/project/ \
  -v "$REPO/qodana-out/python":/data/results/ \
  "$QODANA_PY_IMAGE" --save-report >/tmp/poc-qodana.log 2>&1
[ -f qodana-out/python/qodana.sarif.json ] && ok "Qodana SARIF produced" || no "no SARIF (see /tmp/poc-qodana.log)"
[ -f qodana-out/python/report/index.html ] && ok "Qodana HTML report produced" || no "no HTML report"

hr "3. Start sinain-core (DAST target)"
( cd sinain-core && SINAIN_BIND_HOST=0.0.0.0 PORT=$PORT AGENT_ENABLED=false ESCALATION_MODE=off \
    nohup npm start >/tmp/poc-core.log 2>&1 & echo $! >/tmp/poc-core.pid )
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/feed?after=0" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://localhost:$PORT/feed?after=0" >/dev/null 2>&1 && ok "sinain-core up on :$PORT" || no "server never became ready (see /tmp/poc-core.log)"

hr "4. DAST — OWASP ZAP baseline"
mkdir -p zap-out
docker run --rm ${ADD_HOST[@]+"${ADD_HOST[@]}"} \
  -v "$REPO/zap-out":/zap/wrk/:rw \
  "$ZAP_IMAGE" zap-baseline.py \
    -t "http://host.docker.internal:$PORT" \
    -J zap-report.json -r zap-report.html -I >/tmp/poc-zap.log 2>&1
[ -f zap-out/zap-report.html ] && ok "ZAP HTML report produced" || no "no ZAP HTML report (see /tmp/poc-zap.log)"
[ -f zap-out/zap-report.json ] && ok "ZAP JSON report produced" || no "no ZAP JSON report"

hr "5. Cleanup"
[ -f /tmp/poc-core.pid ] && kill "$(cat /tmp/poc-core.pid)" 2>/dev/null && ok "stopped sinain-core" || echo "  (no server to stop)"

hr "RESULT"
echo "  PASS: $pass    FAIL: $fail"
if [ "$fail" -eq 0 ]; then
  echo "  🎉 Ready for the demo. Reports: qodana-out/python/report/index.html  &  zap-out/zap-report.html"
  exit 0
else
  echo "  ⚠️  Fix the ❌ items above before presenting. Logs are in /tmp/poc-*.log"
  exit 1
fi
