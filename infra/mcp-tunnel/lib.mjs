// Shared crypto + wire-contract helpers for the ChatGPT⇄sinain MCP tunnel.
// Imported by oauth-as.mjs, mcp-authz.mjs, and frps-device-authz.mjs.
// Zero npm deps — node builtins only. See docs/DESIGN-CHATGPT-MCP-TUNNEL.md.
//
// CONTRACT (must match sinain-core/src/mcp-tunnel/* exactly):
//   device key            Ed25519, SPKI PEM public / PKCS8 PEM private
//   handle                base32(sha256(rawPub32))[:16]  ^[a-z2-7]{16}$
//   /pair signature       ed25519 over utf8 `pair|<ts>|<nonce>`        (base64)
//   frp metadata sig      ed25519 over utf8 <handle>                    (base64)
//   tokens                compact JWS, alg=EdDSA, signed by the AS key

import crypto from "node:crypto";

// --- base32 (RFC 4648, lowercase, no padding) ------------------------------
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// --- device identity → handle ----------------------------------------------
/** Extract the 32-byte raw Ed25519 public key from an SPKI PEM. The DER is a
 *  fixed 44 bytes with a 12-byte algorithm prefix; the raw key is the tail. */
export function rawPubFromSpkiPem(spkiPem) {
  const der = pemToDer(spkiPem, "PUBLIC KEY");
  if (der.length < 32) throw new Error("bad SPKI public key");
  return der.subarray(der.length - 32);
}

export function deriveHandle(spkiPem) {
  const raw = rawPubFromSpkiPem(spkiPem);
  const digest = crypto.createHash("sha256").update(raw).digest();
  return base32(digest).slice(0, 16);
}

export const HANDLE_RE = /^[a-z2-7]{16}$/;
export function isHandle(s) {
  return typeof s === "string" && HANDLE_RE.test(s);
}

function pemToDer(pem, label) {
  const body = String(pem)
    .replace(new RegExp(`-----BEGIN ${label}-----`), "")
    .replace(new RegExp(`-----END ${label}-----`), "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

// --- Ed25519 raw signatures (used for /pair and frp metadata) --------------
/** Verify an Ed25519 signature (base64) over `message` (utf8) by `spkiPem`. */
export function verifyEd25519(spkiPem, message, sigB64) {
  try {
    const key = crypto.createPublicKey(spkiPem);
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** Sign `message` (utf8) with a PKCS8 Ed25519 private PEM → base64. */
export function signEd25519(pkcs8Pem, message) {
  const key = crypto.createPrivateKey(pkcs8Pem);
  return crypto.sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

// --- compact JWS (EdDSA) ----------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const b64uJson = (obj) => b64u(JSON.stringify(obj));

/** Sign a claims object → compact JWS string. `privateKey` is a KeyObject. */
export function jwsSign(claims, privateKey, typ = "JWT") {
  const header = b64uJson({ alg: "EdDSA", typ });
  const payload = b64uJson(claims);
  const data = `${header}.${payload}`;
  const sig = crypto.sign(null, Buffer.from(data), privateKey).toString("base64url");
  return `${data}.${sig}`;
}

/** Verify a compact JWS with `publicKey` (KeyObject); returns claims or null.
 *  Checks signature and `exp` (seconds). Does NOT check audience — callers do. */
export function jwsVerify(token, publicKey, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  try {
    const ok = crypto.verify(
      null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(sig, "base64url"),
    );
    if (!ok) return null;
    const h = JSON.parse(Buffer.from(header, "base64url").toString());
    if (h.alg !== "EdDSA") return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof claims.exp === "number" && claims.exp < nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

// --- PKCE (S256) ------------------------------------------------------------
export function pkceMatches(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== "string" || typeof codeChallenge !== "string") return false;
  const computed = crypto.createHash("sha256").update(codeVerifier).digest().toString("base64url");
  // constant-time compare
  const a = Buffer.from(computed), b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- misc -------------------------------------------------------------------
export const PUBLIC_HOST_SUFFIX = ".mcp.sinain.com";
export function resourceForHandle(handle) {
  return `https://${handle}${PUBLIC_HOST_SUFFIX}`;
}
/** Pull the handle out of a request Host header (`<handle>.mcp.sinain.com`). */
export function handleFromHost(host) {
  if (typeof host !== "string") return null;
  const h = host.split(":")[0].toLowerCase();
  if (!h.endsWith(PUBLIC_HOST_SUFFIX)) return null;
  const label = h.slice(0, -PUBLIC_HOST_SUFFIX.length);
  return isHandle(label) ? label : null;
}

export function randomCode(len = 8) {
  // human-typable: base32 alphabet, no ambiguous padding
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += B32[bytes[i] & 31];
  return out;
}
