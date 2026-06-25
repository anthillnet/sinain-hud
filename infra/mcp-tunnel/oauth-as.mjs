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
  pkceMatches, resourceForHandle, randomCode, SHARED_RESOURCE, isAccountId,
} from "./lib.mjs";
import { Idp } from "./idp.mjs";
import { AccountStore } from "./accounts.mjs";

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

// --- optional accounts layer (ChatGPT-only; off unless ACCOUNTS_ENABLED) ----
const ACCOUNTS_ENABLED = process.env.ACCOUNTS_ENABLED === "1" || process.env.ACCOUNTS_ENABLED === "true";
const idp = new Idp({
  mode: process.env.IDP_MODE || "stub",
  issuer: process.env.IDP_ISSUER, clientId: process.env.IDP_CLIENT_ID,
  clientSecret: process.env.IDP_CLIENT_SECRET, asIssuer: ISSUER,
});
const accounts = new AccountStore(join(KEY_DIR, "accounts.json"));
const pendingFed = new Map(); // fedState → { type, ...payload, exp }  (OIDC round-trip)
const FED_TTL = 600;
setInterval(() => { const n = nowSec(); for (const [k, v] of pendingFed) if (v.exp < n) pendingFed.delete(k); }, 60_000).unref();
// Seed the demo account → fixture device for OpenAI review (stable, always-on).
if (ACCOUNTS_ENABLED && process.env.DEMO_FIXTURE_HANDLE) {
  accounts.ensureDemo(`stub|${process.env.DEMO_EMAIL || "demo@sinain.com"}`,
    process.env.DEMO_EMAIL || "demo@sinain.com", process.env.DEMO_FIXTURE_HANDLE);
}

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
    act: true, sub: handle, cc: q.code_challenge, ru: q.redirect_uri,
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
    const sub = claims.sub ?? claims.h; // back-compat with pre-account codes
    if (revoked.has(sub)) return oauthErr(res, 400, "invalid_grant", "revoked");
    return issueTokens(res, sub);
  }
  if (q.grant_type === "refresh_token") {
    const claims = jwsVerify(q.refresh_token, KEY.publicKey);
    if (!claims || !claims.rt) return oauthErr(res, 400, "invalid_grant", "bad refresh token");
    const sub = claims.sub ?? claims.h;
    if (revoked.has(sub)) return oauthErr(res, 400, "invalid_grant", "revoked");
    if (!consumeJti(claims.jti, claims.exp)) return oauthErr(res, 400, "invalid_grant", "refresh token reused");
    return issueTokens(res, sub);
  }
  return oauthErr(res, 400, "unsupported_grant_type", "authorization_code or refresh_token");
}

function issueTokens(res, sub) {
  const iat = nowSec();
  // Account tokens bind to the single shared resource; device-pairing tokens
  // bind to that one handle's resource (mcp-authz enforces the match).
  const resource = isAccountId(sub) ? SHARED_RESOURCE : resourceForHandle(sub);
  const access = jwsSign({
    iss: ISSUER, sub, aud: resource, resource,
    scope: "mcp", iat, exp: iat + ACCESS_TTL,
  }, KEY.privateKey, "at+jwt");
  const refresh = jwsSign({
    rt: true, sub, iat, exp: iat + REFRESH_TTL, jti: newJti(),
  }, KEY.privateKey, "rt+jwt");
  return json(res, 200, {
    access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL,
    refresh_token: refresh, scope: "mcp",
  });
}

// --- accounts: OIDC-federated authorize, callback, device link -------------
const CALLBACK = () => `${ISSUER}/idp/callback`;

// GET /authorize in accounts mode → validate the ChatGPT request, then bounce
// the user to the IdP to log in. The original PKCE/redirect params are parked
// under a fedState we hand the IdP and recover in /idp/callback.
async function handleAuthorizeAccounts(req, res, url) {
  const p = url.searchParams;
  if (p.get("response_type") !== "code") return oauthErr(res, 400, "unsupported_response_type", "only code");
  if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge"))
    return oauthErr(res, 400, "invalid_request", "PKCE S256 required");
  const clientId = p.get("client_id"), redirectUri = p.get("redirect_uri");
  if (!clientId || !redirectUri) return oauthErr(res, 400, "invalid_request", "client_id + redirect_uri required");
  const cimd = await fetchCimd(clientId);
  if (!cimd) return oauthErr(res, 400, "invalid_client", "client_id metadata (CIMD) not resolvable");
  if (!redirectUriAllowed(cimd, redirectUri))
    return oauthErr(res, 400, "invalid_request", "redirect_uri not registered for client");
  const fedState = newJti();
  pendingFed.set(fedState, {
    type: "authz", cc: p.get("code_challenge"), ru: redirectUri,
    cs: p.get("state") || "", exp: nowSec() + FED_TTL,
  });
  const loc = await idp.authorizeUrl(fedState, CALLBACK());
  res.writeHead(302, { location: loc, "cache-control": "no-store" });
  res.end();
}

// GET /device-link?pubkey&ts&nonce&sig — the app opens this (device-signed) to
// link THIS device to whichever account the user logs into.
async function handleDeviceLink(req, res, url) {
  const p = url.searchParams;
  const pubkey = p.get("pubkey"), ts = p.get("ts"), nonce = p.get("nonce"), sig = p.get("sig");
  if (!pubkey || !ts || !nonce || !sig) return oauthErr(res, 400, "invalid_request", "missing fields");
  if (Math.abs(nowSec() - Number(ts)) > CLOCK_SKEW) return oauthErr(res, 400, "invalid_request", "stale timestamp");
  if (!verifyEd25519(pubkey, `link|${ts}|${nonce}`, sig)) return oauthErr(res, 401, "invalid_client", "bad signature");
  const handle = deriveHandle(pubkey);
  const fedState = newJti();
  pendingFed.set(fedState, { type: "link", handle, exp: nowSec() + FED_TTL });
  const loc = await idp.authorizeUrl(fedState, CALLBACK());
  res.writeHead(302, { location: loc, "cache-control": "no-store" });
  res.end();
}

// GET /idp/callback — IdP returned. Resolve the account, then finish whichever
// flow started it (ChatGPT authorize → issue our code; device link → record map).
async function handleIdpCallback(req, res, url) {
  const fedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const p = fedState && pendingFed.get(fedState);
  if (!p || p.exp < nowSec()) return oauthErr(res, 400, "invalid_request", "expired or unknown login state");
  pendingFed.delete(fedState);
  let idpSub, email;
  try { ({ idpSub, email } = await idp.exchange(code, CALLBACK())); }
  catch (e) { return oauthErr(res, 400, "access_denied", `IdP exchange failed: ${e.message}`); }
  const accountId = accounts.upsertByIdpSub(idpSub, email);

  if (p.type === "authz") {
    const jti = newJti();
    const ourCode = jwsSign({
      act: true, sub: accountId, cc: p.cc, ru: p.ru,
      iat: nowSec(), exp: nowSec() + AUTHCODE_TTL, jti,
    }, KEY.privateKey, "authcode");
    const loc = new URL(p.ru);
    loc.searchParams.set("code", ourCode);
    if (p.cs) loc.searchParams.set("state", p.cs);
    console.error(`[as] account authorize ${accountId} (${email}) → code issued`);
    res.writeHead(302, { location: loc.href, "cache-control": "no-store" });
    return res.end();
  }
  if (p.type === "link") {
    accounts.linkDevice(accountId, p.handle);
    console.error(`[as] device ${p.handle} linked to ${accountId} (${email})`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:24rem;margin:12vh auto;text-align:center;color:#111}</style>
<h2>✓ Connected</h2><p>This device is now linked to <b>${esc(email)}</b>. You can use Sinain from ChatGPT.</p>`);
  }
  return oauthErr(res, 400, "invalid_request", "unknown login state");
}

// Stub IdP login (IDP_MODE=stub only) — stands in for the real provider in tests.
function handleStubLoginGet(res, url) {
  const state = url.searchParams.get("state") || "", cb = url.searchParams.get("cb") || "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Sinain login (stub)</title>
<form method=post action="/idp-stub/login">
<input type=hidden name=state value="${esc(state)}"><input type=hidden name=cb value="${esc(cb)}">
<input name=email type=email placeholder=email required><button>Sign in</button></form>`);
}
async function handleStubLoginPost(req, res) {
  const q = parseForm(await readBody(req));
  if (!q.email || !q.cb) return oauthErr(res, 400, "invalid_request", "email + cb required");
  const code = "stub:" + Buffer.from(q.email, "utf8").toString("base64url");
  const loc = new URL(q.cb);
  loc.searchParams.set("code", code);
  if (q.state) loc.searchParams.set("state", q.state);
  res.writeHead(302, { location: loc.href });
  res.end();
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
    // Accounts mode federates /authorize to the IdP; the pairing form is the
    // fallback when accounts are off.
    if (req.method === "GET" && path === "/authorize")
      return ACCOUNTS_ENABLED ? handleAuthorizeAccounts(req, res, url) : handleAuthorizeGet(req, res, url);
    if (req.method === "POST" && path === "/authorize") return handleAuthorizePost(req, res);
    if (req.method === "POST" && path === "/token") return handleToken(req, res);
    if (ACCOUNTS_ENABLED) {
      if (req.method === "GET" && path === "/idp/callback") return handleIdpCallback(req, res, url);
      if (req.method === "GET" && path === "/device-link") return handleDeviceLink(req, res, url);
      if (idp.isStub && req.method === "GET" && path === "/idp-stub/login") return handleStubLoginGet(res, url);
      if (idp.isStub && req.method === "POST" && path === "/idp-stub/login") return handleStubLoginPost(req, res);
    }
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
