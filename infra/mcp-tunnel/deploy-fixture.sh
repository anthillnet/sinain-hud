#!/usr/bin/env bash
# Deploy the OpenAI-review demo fixture: a fixture-core (canned data) + the real
# sinain-mcp-server in front of it + a box-side frpc registering an always-online
# fixture device. The AS links demo@sinain.com → this fixture handle. Run AS ROOT
# on the box from /root/mcp-tunnel (with /root/sinain-mcp-server scp'd alongside).
# See docs/CHATGPT-APP-SUBMISSION.md §6.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/sinain-mcp-tunnel
FIX=/opt/sinain-fixture
USER=sinain-tunnel
FRP_VERSION="${FRP_VERSION:-0.61.1}"
ENV=/etc/sinain-mcp-tunnel/oauth-as.env
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "frpc ${FRP_VERSION}"
if ! command -v frpc >/dev/null; then
  tgz="frp_${FRP_VERSION}_linux_amd64.tar.gz"; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${tgz}" -o "$tmp/$tgz"
  tar -xzf "$tmp/$tgz" -C "$tmp"
  install -m755 "$tmp/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc
  rm -rf "$tmp"
fi
echo "frpc $(frpc --version)"

say "fixture-core + real MCP server"
install -m644 "$SCRIPT_DIR/fixture-core.mjs" "$APP/fixture-core.mjs"
install -d -m755 "$FIX"
rm -rf "$FIX/mcp-server"; mkdir -p "$FIX/mcp-server"
cp /root/sinain-mcp-server/index.ts /root/sinain-mcp-server/package.json "$FIX/mcp-server/"
[ -f /root/sinain-mcp-server/tsconfig.json ] && cp /root/sinain-mcp-server/tsconfig.json "$FIX/mcp-server/"
[ -f /root/sinain-mcp-server/package-lock.json ] && cp /root/sinain-mcp-server/package-lock.json "$FIX/mcp-server/"
( cd "$FIX/mcp-server" && npm install --no-audit --no-fund --silent )
chown -R "$USER:$USER" "$FIX"

say "fixture device + frpc config"
HANDLE=$(node --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs"; import crypto from "node:crypto";
import { deriveHandle, signEd25519 } from "/opt/sinain-mcp-tunnel/lib.mjs";
const P = "/opt/sinain-fixture/device.json";
let id;
if (existsSync(P)) id = JSON.parse(readFileSync(P, "utf8"));
else { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  id = { publicKeyPem: publicKey.export({type:"spki",format:"pem"}), privateKeyPem: privateKey.export({type:"pkcs8",format:"pem"}) };
  writeFileSync(P, JSON.stringify(id), { mode: 0o600 }); }
const h = deriveHandle(id.publicKeyPem), sig = signEd25519(id.privateKeyPem, h);
writeFileSync("/etc/frp/frpc-fixture.toml",
  `serverAddr = "127.0.0.1"\nserverPort = 7000\nloginFailExit = false\n` +
  `metadatas.pubkey = ${JSON.stringify(id.publicKeyPem)}\nmetadatas.sig = ${JSON.stringify(sig)}\n\n` +
  `[[proxies]]\nname = "sinain-fixture"\ntype = "http"\nlocalIP = "127.0.0.1"\nlocalPort = 9520\nsubdomain = ${JSON.stringify(h)}\n`);
process.stdout.write(h);
')
echo "fixture handle: $HANDLE"
chown "$USER:$USER" /opt/sinain-fixture/device.json /etc/frp/frpc-fixture.toml

say "AS env: demo fixture link"
touch "$ENV"
grep -q '^DEMO_FIXTURE_HANDLE=' "$ENV" || echo "DEMO_FIXTURE_HANDLE=" >> "$ENV"
sed -i "s|^DEMO_FIXTURE_HANDLE=.*|DEMO_FIXTURE_HANDLE=$HANDLE|" "$ENV"
grep -q '^DEMO_EMAIL=' "$ENV" || echo "DEMO_EMAIL=demo@sinain.com" >> "$ENV"

say "systemd"
install -m644 "$SCRIPT_DIR"/systemd/sinain-fixture-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sinain-fixture-core sinain-fixture-mcp sinain-fixture-frpc
systemctl restart sinain-oauth-as
sleep 3
for s in sinain-fixture-core sinain-fixture-mcp sinain-fixture-frpc sinain-oauth-as; do
  printf "%-26s %s\n" "$s" "$(systemctl is-active $s)"
done

say "checks"
curl -fsS http://127.0.0.1:9530/health && echo " ← fixture-core"
curl -fsS http://127.0.0.1:18798/online && echo " ← online handles (expect the fixture handle)"
echo "Demo: create Auth0 user demo@sinain.com — it auto-links to fixture handle $HANDLE on login."
