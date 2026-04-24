// Injecting proxy: localhost:11435 → https://openrouter.ai
// Adds `reasoning: {enabled: false}` to every /chat/completions body so DeepSeek
// V4 Flash doesn't emit reasoning_content and openclaude's multi-turn flow works.
// Logs full request/response bytes to /tmp/openrouter-proxy.log for diagnosis.

import http from "http";
import https from "https";
import { appendFileSync, writeFileSync } from "fs";

const LOG = "/tmp/openrouter-proxy.log";
const UPSTREAM_HOST = "openrouter.ai";
const UPSTREAM_PORT = 443;
const LISTEN_PORT = 11435;

writeFileSync(LOG, `# openrouter injecting proxy started ${new Date().toISOString()}\n`);

http.createServer((clientReq, clientRes) => {
  const ts = new Date().toISOString();
  let reqBody = Buffer.alloc(0);
  clientReq.on("data", (c) => { reqBody = Buffer.concat([reqBody, c]); });
  clientReq.on("end", () => {
    // Inject reasoning:{enabled:false} for chat completions requests
    let outBody = reqBody;
    let injected = false;
    if (clientReq.url.includes("/chat/completions") && reqBody.length > 0) {
      try {
        const json = JSON.parse(reqBody.toString("utf8"));
        if (!json.reasoning) {
          json.reasoning = { enabled: false };
          injected = true;
        }
        outBody = Buffer.from(JSON.stringify(json));
      } catch (e) {
        appendFileSync(LOG, `WARN: failed to parse body: ${e.message}\n`);
      }
    }

    appendFileSync(
      LOG,
      `\n========== ${ts} ${clientReq.method} ${clientReq.url} (reasoning-disabled=${injected}) ==========\n` +
      `REQUEST (${outBody.length} bytes):\n${outBody.toString("utf8").slice(0, 4000)}\n` +
      `---------- RESPONSE ----------\n`
    );

    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders.host;
    fwdHeaders["content-length"] = outBody.length;

    const upReq = https.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: clientReq.method,
        path: clientReq.url,
        headers: fwdHeaders,
      },
      (upRes) => {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.on("data", (chunk) => {
          clientRes.write(chunk);
          appendFileSync(LOG, chunk.toString("utf8"));
        });
        upRes.on("end", () => {
          clientRes.end();
          appendFileSync(LOG, `\n========== END ${upRes.statusCode} ==========\n`);
        });
      }
    );
    upReq.on("error", (err) => {
      appendFileSync(LOG, `PROXY ERROR: ${err.message}\n`);
      clientRes.writeHead(502);
      clientRes.end("proxy error: " + err.message);
    });
    upReq.write(outBody);
    upReq.end();
  });
}).listen(LISTEN_PORT, () => {
  console.log(`openrouter injecting proxy: http://localhost:${LISTEN_PORT} → https://${UPSTREAM_HOST}`);
  console.log(`logs: ${LOG}`);
});
