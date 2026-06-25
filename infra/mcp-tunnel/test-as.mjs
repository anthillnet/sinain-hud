// Integration test for oauth-as.mjs: drives the full accountless flow
//   /pair (device-signed) → /authorize (pairing code + PKCE) → /token → refresh
// plus the mcp-authz verification of the issued token. Node builtins only.
//   run:  node test-as.mjs
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveHandle, signEd25519, jwsVerify, resourceForHandle } from "./lib.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// device identity
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const handle = deriveHandle(pubPem);

// mock CIMD client document server (stands in for chatgpt.com/.../client.json)
const REDIRECT = "https://chatgpt.example/callback";
const cimd = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ client_name: "ChatGPT (test)", redirect_uris: [REDIRECT] }));
});
await new Promise((r) => cimd.listen(0, "127.0.0.1", r));
const CLIENT_ID = `http://127.0.0.1:${cimd.address().port}/client.json`;

// boot the AS against a temp key dir
const KEY_DIR = mkdtempSync(join(tmpdir(), "sinain-as-"));
const AS_PORT = 18897;
const ISSUER = `http://127.0.0.1:${AS_PORT}`;
const as = spawn(process.execPath, ["oauth-as.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, AS_PORT: String(AS_PORT), AS_KEY_DIR: KEY_DIR, AS_ISSUER: ISSUER },
  stdio: ["ignore", "ignore", "inherit"],
});
// CIMD over http for the test: allow the AS to fetch a non-https client_id by
// monkey-not-possible — instead the AS requires https. So we point CLIENT_ID at
// http and EXPECT the AS to reject it... no: we want the happy path. Patch: the
// test uses a relaxed AS that trusts http CIMD only when AS_ALLOW_HTTP_CIMD=1.
as.kill();

// Re-spawn with the test escape hatch.
const as2 = spawn(process.execPath, ["oauth-as.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, AS_PORT: String(AS_PORT), AS_KEY_DIR: KEY_DIR, AS_ISSUER: ISSUER, AS_ALLOW_HTTP_CIMD: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
await sleep(500);

try {
  // metadata
  let r = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
  let meta = await r.json();
  ok(meta.code_challenge_methods_supported?.includes("S256"), "metadata advertises S256");
  ok(meta.client_id_metadata_document_supported === true, "metadata advertises CIMD");

  // /pair (device-signed)
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(8).toString("hex");
  const sig = signEd25519(privPem, `pair|${ts}|${nonce}`);
  r = await fetch(`${ISSUER}/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubPem, ts, nonce, sig }) });
  const pair = await r.json();
  ok(r.status === 200 && /^[a-z2-7]{8}$/.test(pair.code || ""), "/pair mints a code: " + pair.code);

  // bad signature rejected
  r = await fetch(`${ISSUER}/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubPem, ts, nonce, sig: "AAAA" }) });
  ok(r.status === 401, "/pair rejects bad signature");

  // PKCE
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest().toString("base64url");
  const resource = resourceForHandle(handle);

  // /authorize POST with the pairing code
  const form = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
    resource, scope: "mcp", code: pair.code,
  });
  r = await fetch(`${ISSUER}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form, redirect: "manual" });
  ok(r.status === 302, "/authorize redirects (302)");
  const loc = new URL(r.headers.get("location"));
  const authCode = loc.searchParams.get("code");
  ok(loc.searchParams.get("state") === "xyz", "/authorize preserves state");
  ok(!!authCode, "/authorize returns an authorization code");

  // reused pairing code now fails (single-use)
  r = await fetch(`${ISSUER}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form, redirect: "manual" });
  ok(r.status === 403, "pairing code is single-use");

  // /token authorization_code + PKCE
  r = await fetch(`${ISSUER}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, code_verifier: verifier }) });
  const tok = await r.json();
  ok(r.status === 200 && tok.access_token && tok.refresh_token, "/token issues access + refresh");

  // verify the access token as mcp-authz would
  const asPub = crypto.createPublicKey(readFileSync(join(KEY_DIR, "as-ed25519-public.pem"), "utf8"));
  const claims = jwsVerify(tok.access_token, asPub);
  ok(claims && claims.resource === resource && claims.scope === "mcp", "access token scoped to handle's resource");

  // wrong PKCE verifier rejected (fresh code)
  // (re-pair → authorize → token with bad verifier)
  const ts2 = Math.floor(Date.now() / 1000), n2 = crypto.randomBytes(8).toString("hex");
  await fetch(`${ISSUER}/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubPem, ts: ts2, nonce: n2, sig: signEd25519(privPem, `pair|${ts2}|${n2}`) }) })
    .then((x) => x.json()).then(async (p2) => {
      const f2 = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", resource, scope: "mcp", code: p2.code });
      const rr = await fetch(`${ISSUER}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: f2, redirect: "manual" });
      const ac2 = new URL(rr.headers.get("location")).searchParams.get("code");
      const bad = await fetch(`${ISSUER}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: ac2, redirect_uri: REDIRECT, code_verifier: "wrong-verifier" }) });
      ok(bad.status === 400, "/token rejects wrong PKCE verifier");
    });

  // refresh_token grant
  r = await fetch(`${ISSUER}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) });
  const refreshed = await r.json();
  ok(r.status === 200 && refreshed.access_token, "refresh_token grant issues a new access token");

  // refresh reuse rejected (rotation)
  r = await fetch(`${ISSUER}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) });
  ok(r.status === 400, "refresh token is single-use (rotated)");

} finally {
  as2.kill();
  cimd.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
