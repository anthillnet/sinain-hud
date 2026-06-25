#!/usr/bin/env node
// Accountless OAuth 2.1 Authorization Server for the ChatGPT⇄sinain MCP tunnel.
// Authorization Code + PKCE, CIMD client registration, device-pairing-code grant.
// No user accounts, no client DB. See docs/DESIGN-CHATGPT-MCP-TUNNEL.md §3.4.
//
// Runs on the Strato box, loopback :18797, fronted by Caddy as auth.sinain.com.
// State: one persisted Ed25519 signing key + ephemeral pairing-code/jti maps.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  deriveHandle, isHandle, verifyEd25519, jwsSign, jwsVerify,
  pkceMatches, resourceForHandle, randomCode,
} from "./lib.mjs";

const PORT = Number(process.env.AS_PORT || 18797);
const ISSUER = (process.env.AS_ISSUER || "https://auth.sinain.com").replace(/\/$/, "");
const KEY_DIR = process.env.AS_KEY_DIR || "/mnt/openclaw-state/sinain-mcp-tunnel";
const PAIR_TTL = 600;        // pairing code lifetime (s)
const ACCESS_TTL = 3600;     // access token lifetime (s)
const REFRESH_TTL = 2592000; // refresh token lifetime (s) — 30d
const AUTHCODE_TTL = 60;     // authorization code lifetime (s)
const CLOCK_SKEW = 300;      // accepted /pair timestamp drift (s)

// --- signing key (persisted; public half consumed by mcp-authz) ------------
function loadOrCreateKey() {
  const privPath = join(KEY_DIR, "as-ed25519-private.pem");
  const pubPath = join(KEY_DIR, "as-ed25519-public.pem");
  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKey: crypto.createPrivateKey(readFileSync(privPath, "utf8")),
      publicKey: crypto.createPublicKey(readFileSync(pubPath, "utf8")),
    };
  }
  if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  console.error(`[as] generated AS signing key → ${KEY_DIR}`);
  return { privateKey, publicKey };
}
const KEY = loadOrCreateKey();

// --- ephemeral state --------------------------------------------------------
const pairings = new Map();     // code → { handle, exp }
const consumedJti = new Map();  // jti → exp  (auth-code + rotated-refresh single-use)
const revoked = new Map();      // handle → revokedAtSec  (blocks refresh; "off means off")

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of pairings) if (v.exp < now) pairings.delete(k);
  for (const [k, exp] of consumedJti) if (exp < now) consumedJti.delete(k);
}, 60_000).unref();

// --- CIMD: validate ChatGPT's client_id metadata document ------------------
const cimdCache = new Map(); // url → { doc, exp }
async function fetchCimd(clientIdUrl) {
  let u;
  try { u = new URL(clientIdUrl); } catch { return null; }
  // Production: CIMD docs must be https. AS_ALLOW_HTTP_CIMD=1 is a TEST-ONLY
  // escape hatch so the integration test can serve client.json over loopback http.
  const allowHttp = process.env.AS_ALLOW_HTTP_CIMD === "1";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return null;
  const now = Date.now();
  const hit = cimdCache.get(u.href);
  if (hit && hit.exp > now) return hit.doc;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(u.href, { signal: ctrl.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const doc = await res.json();
    cimdCache.set(u.href, { doc, exp: now + 300_000 });
    return doc;
  } catch { return null; }
}
function redirectUriAllowed(cimdDoc, redirectUri) {
  const list = Array.isArray(cimdDoc?.redirect_uris) ? cimdDoc.redirect_uris : [];
  return list.includes(redirectUri);
}

// --- helpers ----------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);
const json = (res, code, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body);
};
const oauthErr = (res, code, error, desc) =>
  json(res, code, { error, error_description: desc });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}
function newJti() { return crypto.randomBytes(12).toString("base64url"); }
function consumeJti(jti, exp) {
  if (!jti || consumedJti.has(jti)) return false;
  consumedJti.set(jti, exp);
  return true;
}
function handleFromResource(resource) {
  try {
    const u = new URL(resource);
    const label = u.hostname.split(".")[0];
    return isHandle(label) ? label : null;
  } catch { return null; }
}

// --- endpoints --------------------------------------------------------------
function metadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    // CIMD: ChatGPT passes a hosted client.json URL as client_id; no DCR needed.
    client_id_metadata_document_supported: true,
  };
}

// POST /pair — device-signed; mints the pairing code the overlay displays.
// body: { pubkey: <spki pem>, ts: <unix s>, nonce: <hex>, sig: <base64> }
async function handlePair(req, res) {
  const body = await readBody(req);
  let b;
  try { b = JSON.parse(body); } catch { return oauthErr(res, 400, "invalid_request", "bad json"); }
  const { pubkey, ts, nonce, sig } = b || {};
  if (!pubkey || !ts || !nonce || !sig) return oauthErr(res, 400, "invalid_request", "missing fields");
  if (Math.abs(nowSec() - Number(ts)) > CLOCK_SKEW) return oauthErr(res, 400, "invalid_request", "stale timestamp");
  if (!verifyEd25519(pubkey, `pair|${ts}|${nonce}`, sig)) return oauthErr(res, 401, "invalid_client", "bad signature");
  let handle;
  try { handle = deriveHandle(pubkey); } catch { return oauthErr(res, 400, "invalid_request", "bad pubkey"); }
  revoked.delete(handle); // pairing re-enables a previously toggled-off handle
  const code = randomCode(8);
  pairings.set(code, { handle, exp: nowSec() + PAIR_TTL });
  console.error(`[as] /pair handle=${handle} code minted (ttl ${PAIR_TTL}s)`);
  return json(res, 200, { code, expires_in: PAIR_TTL });
}

// POST /unpair — device-signed; revokes a handle (blocks token refresh).
async function handleUnpair(req, res) {
  const body = await readBody(req);
  let b;
  try { b = JSON.parse(body); } catch { return oauthErr(res, 400, "invalid_request", "bad json"); }
  const { pubkey, ts, nonce, sig } = b || {};
  if (!pubkey || !ts || !nonce || !sig) return oauthErr(res, 400, "invalid_request", "missing fields");
  if (Math.abs(nowSec() - Number(ts)) > CLOCK_SKEW) return oauthErr(res, 400, "invalid_request", "stale timestamp");
  if (!verifyEd25519(pubkey, `unpair|${ts}|${nonce}`, sig)) return oauthErr(res, 401, "invalid_client", "bad signature");
  const handle = deriveHandle(pubkey);
  revoked.set(handle, nowSec());
  for (const [code, v] of pairings) if (v.handle === handle) pairings.delete(code);
  console.error(`[as] /unpair handle=${handle} revoked`);
  return json(res, 200, { revoked: true });
}

// GET /authorize — render the pairing-code consent form.
async function handleAuthorizeGet(req, res, url) {
  const p = url.searchParams;
  const q = {
    response_type: p.get("response_type"), client_id: p.get("client_id"),
    redirect_uri: p.get("redirect_uri"), code_challenge: p.get("code_challenge"),
    code_challenge_method: p.get("code_challenge_method"), state: p.get("state") || "",
    resource: p.get("resource") || "", scope: p.get("scope") || "mcp",
  };
  if (q.response_type !== "code") return oauthErr(res, 400, "unsupported_response_type", "only code");
  if (q.code_challenge_method !== "S256" || !q.code_challenge)
    return oauthErr(res, 400, "invalid_request", "PKCE S256 required");
  if (!q.client_id || !q.redirect_uri) return oauthErr(res, 400, "invalid_request", "client_id + redirect_uri required");
  const cimd = await fetchCimd(q.client_id);
  if (!cimd) return oauthErr(res, 400, "invalid_client", "client_id metadata (CIMD) not resolvable");
  if (!redirectUriAllowed(cimd, q.redirect_uri))
    return oauthErr(res, 400, "invalid_request", "redirect_uri not registered for client");
  const clientName = esc(cimd.client_name || "ChatGPT");
  const hidden = Object.entries(q)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Sinain</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:26rem;margin:8vh auto;padding:0 1.2rem;color:#111}
h1{font-size:1.25rem}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:.3rem}
input[name=code]{font-size:1.4rem;letter-spacing:.18em;text-transform:lowercase;width:100%;padding:.6rem;margin:.6rem 0;
border:1px solid #ccc;border-radius:.5rem;text-align:center}button{font-size:1rem;padding:.7rem 1.2rem;border:0;border-radius:.5rem;
background:#111;color:#fff;width:100%}small{color:#666}</style>
<h1>Connect ${clientName} to Sinain</h1>
<p>Enter the <b>pairing code</b> shown in your Sinain overlay settings.</p>
<form method="post" action="/authorize">${hidden}
<input name="code" autocomplete="off" autofocus placeholder="pairing code" maxlength="8" pattern="[A-Za-z2-7]{8}" required>
<button type="submit">Authorize</button></form>
<p><small>This grants ${clientName} read access to your live screen context while the connector is enabled. The code expires in ${Math.round(PAIR_TTL / 60)} minutes.</small></p>`);
}

// POST /authorize — validate code, issue authorization code, redirect.
async function handleAuthorizePost(req, res) {
  const q = parseForm(await readBody(req));
  if (q.response_type !== "code" || q.code_challenge_method !== "S256")
    return oauthErr(res, 400, "invalid_request", "bad params");
  const entry = pairings.get(String(q.code || "").toLowerCase());
  if (!entry || entry.exp < nowSec()) return oauthErr(res, 403, "access_denied", "invalid or expired pairing code");
  pairings.delete(String(q.code).toLowerCase()); // single-use
  const handle = entry.handle;
  if (q.resource) {
    const rh = handleFromResource(q.resource);
    if (rh && rh !== handle) return oauthErr(res, 400, "invalid_request", "resource/handle mismatch");
  }
  // Re-validate redirect_uri against CIMD (defense in depth — form is attacker-mutable).
  const cimd = await fetchCimd(q.client_id);
  if (!cimd || !redirectUriAllowed(cimd, q.redirect_uri))
    return oauthErr(res, 400, "invalid_request", "redirect_uri not registered");
  const jti = newJti();
  const code = jwsSign({
    act: true, h: handle, cc: q.code_challenge, ru: q.redirect_uri,
    iat: nowSec(), exp: nowSec() + AUTHCODE_TTL, jti,
  }, KEY.privateKey, "authcode");
  const loc = new URL(q.redirect_uri);
  loc.searchParams.set("code", code);
  if (q.state) loc.searchParams.set("state", q.state);
  console.error(`[as] /authorize handle=${handle} → code issued`);
  res.writeHead(302, { location: loc.href, "cache-control": "no-store" });
  res.end();
}

// POST /token — authorization_code (PKCE) + refresh_token grants.
async function handleToken(req, res) {
  const q = parseForm(await readBody(req));
  if (q.grant_type === "authorization_code") {
    const claims = jwsVerify(q.code, KEY.publicKey);
    if (!claims || !claims.act) return oauthErr(res, 400, "invalid_grant", "bad authorization code");
    if (!consumeJti(claims.jti, claims.exp)) return oauthErr(res, 400, "invalid_grant", "code already used");
    if (q.redirect_uri !== claims.ru) return oauthErr(res, 400, "invalid_grant", "redirect_uri mismatch");
    if (!pkceMatches(q.code_verifier, claims.cc)) return oauthErr(res, 400, "invalid_grant", "PKCE verification failed");
    if (revoked.has(claims.h)) return oauthErr(res, 400, "invalid_grant", "handle revoked");
    return issueTokens(res, claims.h);
  }
  if (q.grant_type === "refresh_token") {
    const claims = jwsVerify(q.refresh_token, KEY.publicKey);
    if (!claims || !claims.rt) return oauthErr(res, 400, "invalid_grant", "bad refresh token");
    if (revoked.has(claims.h)) return oauthErr(res, 400, "invalid_grant", "handle revoked");
    if (!consumeJti(claims.jti, claims.exp)) return oauthErr(res, 400, "invalid_grant", "refresh token reused");
    return issueTokens(res, claims.h);
  }
  return oauthErr(res, 400, "unsupported_grant_type", "authorization_code or refresh_token");
}

function issueTokens(res, handle) {
  const iat = nowSec();
  const access = jwsSign({
    iss: ISSUER, sub: handle, aud: resourceForHandle(handle), resource: resourceForHandle(handle),
    scope: "mcp", iat, exp: iat + ACCESS_TTL,
  }, KEY.privateKey, "at+jwt");
  const refresh = jwsSign({
    rt: true, h: handle, iat, exp: iat + REFRESH_TTL, jti: newJti(),
  }, KEY.privateKey, "rt+jwt");
  return json(res, 200, {
    access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL,
    refresh_token: refresh, scope: "mcp",
  });
}

// --- router -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ISSUER);
    const path = url.pathname.replace(/\/$/, "") || "/";
    // CORS for the SPA-less flows is unnecessary (browser navigations), but the
    // token endpoint is called server-to-server by ChatGPT — no CORS needed.
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server")
      return json(res, 200, metadata());
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "POST" && path === "/pair") return handlePair(req, res);
    if (req.method === "POST" && path === "/unpair") return handleUnpair(req, res);
    if (req.method === "GET" && path === "/authorize") return handleAuthorizeGet(req, res, url);
    if (req.method === "POST" && path === "/authorize") return handleAuthorizePost(req, res);
    if (req.method === "POST" && path === "/token") return handleToken(req, res);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (err) {
    console.error("[as] handler error:", err?.stack || err);
    if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: "server_error" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`sinain OAuth AS listening on http://127.0.0.1:${PORT} (issuer ${ISSUER})`);
});
