#!/usr/bin/env bash
# Deploy the sinain MCP tunnel stack to the Strato box (Debian 12).
# Idempotent. Validates Caddy before reloading so a bad config never drops the
# live gateway WSS. Run AS ROOT on the box, from a copy of infra/mcp-tunnel/.
#
#   scp -i ~/.ssh/id_ed25519_strato -r infra/mcp-tunnel root@85.214.180.247:/root/
#   ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247
#   cd /root/mcp-tunnel && FRP_SHA256=<sha> ./deploy.sh [--wire-caddy]
#
# Prereqs already on the box (see docs/deploy/strato.md): Caddy, certbot +
# python3-certbot-dns-cloudflare, /etc/letsencrypt/cloudflare.ini, node, the
# Cloudflare grey-cloud A records  mcp.sinain.com / *.mcp.sinain.com / auth.sinain.com.
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.61.1}"
FRP_SHA256="${FRP_SHA256:-}"                 # sha256 of frp_<ver>_linux_amd64.tar.gz (fail-closed)
WIRE_CADDY=0; [[ "${1:-}" == "--wire-caddy" ]] && WIRE_CADDY=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR=/opt/sinain-mcp-tunnel
KEY_DIR=/mnt/openclaw-state/sinain-mcp-tunnel
TLS_DIR=/etc/sinain-mcp-tunnel/tls
CADDY_SITE=/etc/caddy/sites/sinain-mcp-tunnel.caddy
CERT_NAME=sinain-mcp-wildcard
USER=sinain-tunnel

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "user + directories"
id -u "$USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"
install -d -m755 "$APP_DIR" /etc/frp /etc/caddy/sites /var/log/frp
install -d -m750 -o "$USER" -g "$USER" "$KEY_DIR"
install -d -m750 -o "$USER" -g "$USER" "$(dirname "$TLS_DIR")" "$TLS_DIR"
chown "$USER:$USER" /var/log/frp

say "frps ${FRP_VERSION}"
if ! command -v frps >/dev/null || [[ "$(frps --version 2>/dev/null || true)" != "$FRP_VERSION" ]]; then
  tgz="frp_${FRP_VERSION}_linux_amd64.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${tgz}" -o "$tmp/$tgz"
  if [[ -n "$FRP_SHA256" ]]; then
    echo "${FRP_SHA256}  $tmp/$tgz" | sha256sum -c - || { echo "frp checksum mismatch"; exit 1; }
  else
    echo "WARNING: FRP_SHA256 not set — skipping integrity check (got $(sha256sum "$tmp/$tgz" | cut -d' ' -f1))"
  fi
  tar -xzf "$tmp/$tgz" -C "$tmp"
  install -m755 "$tmp/frp_${FRP_VERSION}_linux_amd64/frps" /usr/local/bin/frps
  rm -rf "$tmp"
fi

say "node services + frps config"
install -m644 "$SCRIPT_DIR"/lib.mjs "$SCRIPT_DIR"/oauth-as.mjs "$SCRIPT_DIR"/mcp-authz.mjs "$SCRIPT_DIR"/frps-device-authz.mjs "$APP_DIR"/
install -m644 "$SCRIPT_DIR"/frps.toml /etc/frp/frps.toml

say "systemd units"
install -m644 "$SCRIPT_DIR"/systemd/*.service /etc/systemd/system/
systemctl daemon-reload

say "wildcard TLS cert (certbot DNS-01) for *.mcp.sinain.com"
cat > /etc/sinain-mcp-tunnel-deploy-cert.sh <<EOF
#!/bin/bash
set -e
install -m640 -o $USER -g $USER /etc/letsencrypt/live/$CERT_NAME/fullchain.pem $TLS_DIR/fullchain.pem
install -m640 -o $USER -g $USER /etc/letsencrypt/live/$CERT_NAME/privkey.pem  $TLS_DIR/privkey.pem
systemctl reload caddy 2>/dev/null || true
EOF
chmod +x /etc/sinain-mcp-tunnel-deploy-cert.sh
if [[ ! -d "/etc/letsencrypt/live/$CERT_NAME" ]]; then
  certbot certonly --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    --cert-name "$CERT_NAME" -d '*.mcp.sinain.com' -d 'mcp.sinain.com' \
    --non-interactive --agree-tos -m contact@sinain.com \
    --deploy-hook /etc/sinain-mcp-tunnel-deploy-cert.sh
else
  /etc/sinain-mcp-tunnel-deploy-cert.sh    # ensure files are present on re-run
fi

say "enable services"
systemctl enable --now sinain-frps-authz.service sinain-oauth-as.service sinain-mcp-authz.service frps.service
sleep 1
systemctl --no-pager --lines=0 status sinain-oauth-as sinain-mcp-authz sinain-frps-authz frps | grep -E 'Active:' || true

say "Caddy site"
install -m644 "$SCRIPT_DIR"/Caddyfile.snippet "$CADDY_SITE"
if [[ $WIRE_CADDY -eq 1 ]]; then
  if ! grep -q 'import /etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)" 2>/dev/null || true
    printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
  fi
  if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    systemctl reload caddy
    echo "Caddy reloaded."
  else
    echo "Caddy validation FAILED — NOT reloading. Inspect $CADDY_SITE."; exit 1
  fi
else
  echo "Caddy site written to $CADDY_SITE but NOT wired (safe default)."
  echo "To activate: add 'import /etc/caddy/sites/*.caddy' to /etc/caddy/Caddyfile,"
  echo "then: caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy"
  echo "(or re-run with --wire-caddy to do it with validate+rollback safety)."
fi

say "sanity checks"
curl -fsS http://127.0.0.1:18797/healthz && echo " ← AS ok"
curl -fsS http://127.0.0.1:18797/.well-known/oauth-authorization-server >/dev/null && echo "AS metadata ok"
echo "Done."
