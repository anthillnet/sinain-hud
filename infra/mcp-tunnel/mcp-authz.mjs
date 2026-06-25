#!/usr/bin/env node
// Edge authorizer for the MCP tunnel — Caddy `forward_auth` target.
// Validates the ChatGPT-presented JWT and resolves WHICH device to route to:
//   • device-pairing token (sub = handle)  → that handle
//   • account token        (sub = acct_…)  → the account's currently-online device
// Emits X-Mcp-Handle for the (single-endpoint) Caddy site to set the upstream Host.
// See docs/DESIGN-CHATGPT-MCP-TUNNEL.md §3.3 and docs/DESIGN-CHATGPT-ACCOUNTS.md.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  jwsVerify, handleFromHost, resourceForHandle, isHandle, isAccountId,
  SHARED_RESOURCE, PUBLIC_HOST_SUFFIX,
} from "./lib.mjs";
import { AccountStore } from "./accounts.mjs";

const PORT = Number(process.env.AUTHZ_PORT || 18796);
const KEY_DIR = process.env.AS_KEY_DIR || "/mnt/openclaw-state/sinain-mcp-tunnel";
const PUB_PATH = join(KEY_DIR, "as-ed25519-public.pem");
const ACCOUNTS_PATH = join(KEY_DIR, "accounts.json");
const FRPS_AUTHZ_URL = process.env.FRPS_AUTHZ_URL || "http://127.0.0.1:18798";

// Hot-reload the AS public key (rotatable); cache by mtime.
let cachedKey = { mtimeMs: 0, key: null };
function asPublicKey() {
  const st = statSync(PUB_PATH);
  if (st.mtimeMs !== cachedKey.mtimeMs) {
    cachedKey = { mtimeMs: st.mtimeMs, key: crypto.createPublicKey(readFileSync(PUB_PATH, "utf8")) };
  }
  return cachedKey.key;
}

// Hot-reload the account store by mtime (the AS writes it).
let cachedAcct = { mtimeMs: -1, store: null };
function accountStore() {
  let m = 0;
  try { m = statSync(ACCOUNTS_PATH).mtimeMs; } catch { /* not created yet */ }
  if (m !== cachedAcct.mtimeMs) cachedAcct = { mtimeMs: m, store: new AccountStore(ACCOUNTS_PATH) };
  return cachedAcct.store;
}

async function onlineHandles() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${FRPS_AUTHZ_URL}/online`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return new Set();
    return new Set((await res.json()).handles || []);
  } catch { return new Set(); }
}

function deny(res, host) {
  const meta = `https://${host}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    "www-authenticate": `Bearer resource_metadata="${meta}"`,
    "content-type": "application/json", "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}
function offline(res) {
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "device_offline", error_description: "No Sinain device is currently online for this account." }));
}
function allow(res, handle) {
  res.writeHead(204, { "x-mcp-handle": handle });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers["x-forwarded-host"] || req.headers["host"] || "").toString().split(":")[0];
    const auth = (req.headers["authorization"] || "").toString();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return deny(res, host || `unknown${PUBLIC_HOST_SUFFIX}`);

    const claims = jwsVerify(m[1], asPublicKey());
    const scopeOk = typeof claims?.scope === "string" && claims.scope.split(/\s+/).includes("mcp");
    if (!claims || !scopeOk) return deny(res, host);
    const sub = claims.sub;
    const resOf = (c) => c.resource || c.aud;

    // Account token → route to the account's online device.
    if (isAccountId(sub)) {
      if (resOf(claims) !== SHARED_RESOURCE) return deny(res, host);
      const devices = accountStore()?.devicesFor(sub) || [];
      const live = await onlineHandles();
      const route = devices.find((h) => live.has(h));
      if (!route) {
        console.error(`[authz] device_offline account=${sub} (${devices.length} linked, ${live.size} online)`);
        return offline(res);
      }
      return allow(res, route);
    }

    // Device-pairing token → that one handle (resource must match it).
    if (isHandle(sub)) {
      if (resOf(claims) !== resourceForHandle(sub)) return deny(res, host);
      return allow(res, sub);
    }

    // Legacy fallback: no usable sub → route by the request host (per-subdomain).
    const h = handleFromHost(host);
    if (h && resOf(claims) === resourceForHandle(h)) return allow(res, h);
    return deny(res, host);
  } catch (err) {
    console.error("[authz] error:", err?.message || err);
    if (!res.headersSent) res.writeHead(401).end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`sinain mcp-authz listening on http://127.0.0.1:${PORT} (AS pub ${PUB_PATH})`);
});
