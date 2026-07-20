// End-to-end test of the optional accounts layer with the STUB IdP:
//   device-link → account created + device linked
//   ChatGPT authorize (account login) → PKCE token with sub=acct_…
//   mcp-authz: account token → online device (204); offline → 503
// Boots the AS + frps-authz plugin + mcp-authz against a temp key dir. No box.
//   run:  node test-accounts.mjs
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveHandle, signEd25519, jwsVerify } from "./lib.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (o) => new URLSearchParams(o);
const post = (u, body, headers) => fetch(u, { method: "POST", headers, body, redirect: "manual" });

// ---- fixtures --------------------------------------------------------------
const dev = crypto.generateKeyPairSync("ed25519");
const pubPem = dev.publicKey.export({ type: "spki", format: "pem" });
const privPem = dev.privateKey.export({ type: "pkcs8", format: "pem" });
const handle = deriveHandle(pubPem);
const EMAIL = "alice@example.com";
const WAITLIST_EMAIL = "waitlist@example.com";

const KEY_DIR = mkdtempSync(join(tmpdir(), "sinain-acct-"));
const AS_PORT = 18997, AUTHZ_PORT = 18996, FRPS_PORT = 18998;
const ISSUER = `http://127.0.0.1:${AS_PORT}`;
const RESOURCE = "https://mcp.sinain.com";
const env = {
  ...process.env, AS_KEY_DIR: KEY_DIR, ACCOUNTS_ENABLED: "1", ACCOUNT_AUTHORIZE: "1", IDP_MODE: "stub",
  AS_ALLOW_HTTP_CIMD: "1", SINAIN_MCP_RESOURCE: RESOURCE,
};

// mock CIMD client document (stands in for ChatGPT)
const REDIRECT = "https://chatgpt.example/callback";
const cimd = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ client_name: "ChatGPT (test)", redirect_uris: [REDIRECT] }));
});
await new Promise((r) => cimd.listen(0, "127.0.0.1", r));
const CLIENT_ID = `http://127.0.0.1:${cimd.address().port}/client.json`;

// boot the three services
const as = spawn(process.execPath, ["oauth-as.mjs"], { cwd: import.meta.dirname,
  env: { ...env, AS_PORT: String(AS_PORT), AS_ISSUER: ISSUER }, stdio: ["ignore", "ignore", "inherit"] });
const frps = spawn(process.execPath, ["frps-device-authz.mjs"], { cwd: import.meta.dirname,
  env: { ...env, FRPS_AUTHZ_PORT: String(FRPS_PORT) }, stdio: ["ignore", "ignore", "inherit"] });
const authz = spawn(process.execPath, ["mcp-authz.mjs"], { cwd: import.meta.dirname,
  env: { ...env, AUTHZ_PORT: String(AUTHZ_PORT), FRPS_AUTHZ_URL: `http://127.0.0.1:${FRPS_PORT}` },
  stdio: ["ignore", "ignore", "inherit"] });
await sleep(600);

// helper: run the stub login leg (302 → stub login → 302 → /idp/callback)
async function stubLogin(startUrl, email = EMAIL) {
  let r = await fetch(startUrl, { redirect: "manual" });
  if (r.status !== 302) throw new Error(`expected 302 to stub login, got ${r.status}`);
  const login = new URL(r.headers.get("location"));            // /idp-stub/login?state&cb
  const state = login.searchParams.get("state"), cb = login.searchParams.get("cb");
  r = await post(`${ISSUER}/idp-stub/login`, form({ email, state, cb }),
    { "content-type": "application/x-www-form-urlencoded" });  // → 302 /idp/callback?code&state
  if (r.status !== 302) throw new Error(`stub login POST: ${r.status}`);
  return fetch(r.headers.get("location"), { redirect: "manual" }); // GET /idp/callback
}

try {
  // 1) device-link → account created + device linked
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(6).toString("hex");
  const linkSig = signEd25519(privPem, `link|${ts}|${nonce}`);
  const linkUrl = `${ISSUER}/device-link?pubkey=${encodeURIComponent(pubPem)}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(linkSig)}`;
  let r = await stubLogin(linkUrl);
  ok(r.status === 200, "device-link completes (200 Connected)");
  const store = JSON.parse(readFileSync(join(KEY_DIR, "accounts.json"), "utf8"));
  const acctId = store.accountByDevice[handle];
  ok(/^acct_[0-9a-f]{24}$/.test(acctId || ""), "device mapped to an account: " + acctId);
  ok(store.accounts[acctId]?.email === EMAIL, "account carries the IdP email");

  // 2) signup → account created + marked waitlisted
  r = await stubLogin(`${ISSUER}/signup`, WAITLIST_EMAIL);
  ok(r.status === 200 && (await r.text()).includes("waitlist"), "signup completes with waitlist confirmation");
  const signupStore = JSON.parse(readFileSync(join(KEY_DIR, "accounts.json"), "utf8"));
  const waitlisted = Object.values(signupStore.accounts).find((a) => a.email === WAITLIST_EMAIL);
  ok(waitlisted?.waitlisted === true && !!waitlisted.waitlistedAt, "signup account is marked waitlisted with a timestamp");

  // 3) ChatGPT authorize (account login) → PKCE token sub=acct_…
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest().toString("base64url");
  const authUrl = `${ISSUER}/authorize?` + form({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "cs1", scope: "mcp",
  });
  r = await stubLogin(authUrl);                                 // /idp/callback → 302 redirect_uri?code
  ok(r.status === 302, "account authorize returns a code (302 to redirect_uri)");
  const back = new URL(r.headers.get("location"));
  ok(back.searchParams.get("state") === "cs1", "client state preserved");
  const authCode = back.searchParams.get("code");

  r = await post(`${ISSUER}/token`, form({
    grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, code_verifier: verifier,
  }), { "content-type": "application/x-www-form-urlencoded" });
  const tok = await r.json();
  const asPub = crypto.createPublicKey(readFileSync(join(KEY_DIR, "as-ed25519-public.pem"), "utf8"));
  const claims = jwsVerify(tok.access_token, asPub);
  ok(r.status === 200 && claims?.sub === acctId, "token subject is the account id");
  ok(claims?.resource === RESOURCE, "token bound to the single shared resource");

  // 4) mcp-authz: account token → online device
  // bring the device "online" by simulating frps NewProxy
  const fsig = signEd25519(privPem, handle);
  const np = await post(`http://127.0.0.1:${FRPS_PORT}/handle`, JSON.stringify({
    op: "NewProxy", content: { user: { metas: { pubkey: pubPem, sig: fsig }, run_id: "run-1" }, subdomain: handle, proxy_name: "sinain-mcp" },
  }), { "content-type": "application/json" });
  ok((await np.json()).reject === false, "frps-authz admits the device (online)");

  const verify = (tokn) => fetch(`http://127.0.0.1:${AUTHZ_PORT}/verify`, {
    headers: { authorization: `Bearer ${tokn}`, "x-forwarded-host": "mcp.sinain.com" },
  });
  r = await verify(tok.access_token);
  ok(r.status === 204 && r.headers.get("x-mcp-handle") === handle, "account token routes to the online device (204 + X-Mcp-Handle)");

  // 5) take the device offline → 503
  await post(`http://127.0.0.1:${FRPS_PORT}/handle`, JSON.stringify({
    op: "CloseProxy", content: { user: { run_id: "run-1" }, proxy_name: "sinain-mcp" },
  }), { "content-type": "application/json" });
  r = await verify(tok.access_token);
  ok(r.status === 503, "offline account device → 503 device_offline");

  // 6) tampered token rejected
  r = await verify(tok.access_token.slice(0, -3) + "xyz");
  ok(r.status === 401, "tampered account token → 401");

} catch (e) {
  fail++; console.log("  EXCEPTION:", e.message);
} finally {
  as.kill(); frps.kill(); authz.kill(); cimd.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
