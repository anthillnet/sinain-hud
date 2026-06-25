#!/usr/bin/env node
// frps server-plugin: authorizes tunnel registration by DEVICE SIGNATURE, so no
// shared frp secret ships in the app. frps POSTs each NewProxy here; we confirm
// the client owns the subdomain it claims. See DESIGN-CHATGPT-MCP-TUNNEL.md §3.1.
//
//   frpc sends (client metadatas):  pubkey=<spki pem>, sig=ed25519(handle)
//   subdomain MUST equal deriveHandle(pubkey) and the signature MUST verify.
//
// A static signature is sufficient: it only ever proves "I hold this device key",
// and a replay can still only claim ITS OWN handle.

import http from "node:http";
import { deriveHandle, isHandle, verifyEd25519 } from "./lib.mjs";

const PORT = Number(process.env.FRPS_AUTHZ_PORT || 18798);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 256 * 1024) req.destroy(); });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}
const allow = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ reject: false, unchange: true })); };
const reject = (res, reason) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ reject: true, reject_reason: reason })); };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    const body = JSON.parse(await readBody(req));
    if (body.op !== "NewProxy") return allow(res); // we only gate proxy registration

    const c = body.content || {};
    const metas = (c.user && c.user.metas) || {};
    const subdomain = String(c.subdomain || "").toLowerCase();
    const { pubkey, sig } = metas;

    if (!isHandle(subdomain)) return reject(res, "invalid subdomain");
    if (!pubkey || !sig) return reject(res, "missing device credentials");
    let handle;
    try { handle = deriveHandle(pubkey); } catch { return reject(res, "bad pubkey"); }
    if (handle !== subdomain) return reject(res, "subdomain does not match device key");
    if (!verifyEd25519(pubkey, handle, sig)) return reject(res, "bad device signature");

    console.error(`[frps-authz] NewProxy allowed handle=${handle} proxy=${c.proxy_name}`);
    return allow(res);
  } catch (err) {
    console.error("[frps-authz] error:", err?.message || err);
    return reject(res, "authz error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`sinain frps-device-authz listening on http://127.0.0.1:${PORT}/handle`);
});
