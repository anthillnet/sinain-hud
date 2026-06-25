// Device-identity → tunnel handle + signing. TS port of infra/mcp-tunnel/lib.mjs
// — the derivations here MUST match it byte-for-byte or the frps plugin and the
// OAuth AS will reject this client. See docs/DESIGN-CHATGPT-MCP-TUNNEL.md.
import { createHash, createPublicKey, createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEVICE_IDENTITY_PATH = join(homedir(), ".sinain", "device-identity.json");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Raw 32-byte Ed25519 public key (tail of the 44-byte SPKI DER). */
function rawPub(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

export interface TunnelIdentity {
  handle: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Derive the public tunnel handle from a device SPKI PEM. */
export function deriveHandle(publicKeyPem: string): string {
  return base32(createHash("sha256").update(rawPub(publicKeyPem)).digest()).slice(0, 16);
}

/** Load the device identity sinain-core already persists (shared with the
 *  OpenClaw WS client). Returns null if it hasn't been created yet. */
export function loadTunnelIdentity(): TunnelIdentity | null {
  try {
    if (!existsSync(DEVICE_IDENTITY_PATH)) return null;
    const p = JSON.parse(readFileSync(DEVICE_IDENTITY_PATH, "utf8"));
    if (p?.publicKeyPem && p?.privateKeyPem) {
      return { handle: deriveHandle(p.publicKeyPem), publicKeyPem: p.publicKeyPem, privateKeyPem: p.privateKeyPem };
    }
  } catch { /* fall through */ }
  return null;
}

/** Ed25519-sign a utf8 message with the device private key → base64. */
export function signMessage(privateKeyPem: string, message: string): string {
  return edSign(null, Buffer.from(message, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}
