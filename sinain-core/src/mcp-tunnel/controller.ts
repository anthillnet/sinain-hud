// TunnelController — brings up / tears down the ChatGPT MCP tunnel with the
// harness toggle. Spawns the HTTP MCP transport (:9510) + frpc, runs the
// device-signed /pair, and surfaces {connectorUrl, pairingCode} to the overlay.
// See docs/DESIGN-CHATGPT-MCP-TUNNEL.md §3.5.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { log, debug, error } from "../log.js";
import { loadTunnelIdentity, signMessage, type TunnelIdentity } from "./handle.js";

const TAG = "mcp-tunnel";

export type TunnelStatus = "off" | "starting" | "live" | "error";
export interface TunnelState {
  enabled: boolean;
  status: TunnelStatus;
  handle?: string;
  connectorUrl?: string;
  pairingCode?: string;
  pairingExpiresAt?: number; // epoch ms
  error?: string;
}

export interface TunnelDeps {
  packageRoot: string;        // for tsx + the mcp-server entry
  corePort: number;           // SINAIN_CORE_URL = http://localhost:<corePort>
  workspace: string;          // SINAIN_WORKSPACE for the MCP server
  onState: (s: TunnelState) => void;
}

const AS_BASE = (process.env.SINAIN_OAUTH_AS_URL || "https://auth.sinain.com").replace(/\/$/, "");
const TUNNEL_HOST = process.env.SINAIN_MCP_TUNNEL_HOST || "mcp.sinain.com";
const TUNNEL_PORT = Number(process.env.SINAIN_MCP_TUNNEL_PORT || 7000);
const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 9510);
const TLS_ENABLE = process.env.SINAIN_MCP_TUNNEL_TLS !== "0";
const PAIR_REFRESH_LEAD_MS = 30_000;
// Marker the launcher reads to decide whether to provision frpc on next launch,
// so non-users never download it. Written on enable, removed on disable.
const TUNNEL_MARKER = join(homedir(), ".sinain", "mcp-tunnel-enabled");

/** Resolve the provisioned frpc binary (launcher.js places it; env overrides). */
function resolveFrpcBin(): string | null {
  const candidates = [
    process.env.SINAIN_FRPC_BIN,
    join(homedir(), ".sinain", "bin", "frpc"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export class TunnelController {
  private state: TunnelState = { enabled: false, status: "off" };
  private mcpHttp: ChildProcess | null = null;
  private frpc: ChildProcess | null = null;
  private identity: TunnelIdentity | null = null;
  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;

  constructor(private readonly deps: TunnelDeps) {}

  getState(): TunnelState { return this.state; }

  private push(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch };
    try { this.deps.onState(this.state); } catch { /* overlay may be absent */ }
  }

  async start(): Promise<void> {
    if (this.starting || this.state.status === "live") { this.push({ enabled: true }); return; }
    this.starting = true;
    this.push({ enabled: true, status: "starting", error: undefined });
    // Record intent so the launcher provisions frpc on the next launch even if
    // it isn't present yet on this one.
    try { mkdirSync(join(homedir(), ".sinain"), { recursive: true }); writeFileSync(TUNNEL_MARKER, ""); } catch { /* */ }

    const id = loadTunnelIdentity();
    if (!id) { this.fail("device identity not ready"); return; }
    this.identity = id;
    const connectorUrl = `https://${id.handle}.${TUNNEL_HOST}/mcp`;

    const frpcBin = resolveFrpcBin();
    if (!frpcBin) { this.fail("frpc not installed yet — relaunch sinain to provision it, then re-enable"); return; }

    try {
      this.startMcpHttp();
      this.startFrpc(frpcBin, id);
    } catch (e: any) {
      this.fail(`spawn failed: ${e?.message ?? e}`);
      return;
    }

    this.push({ status: "live", handle: id.handle, connectorUrl });
    log(TAG, `tunnel up → ${connectorUrl} (frps ${TUNNEL_HOST}:${TUNNEL_PORT})`);
    this.starting = false;
    await this.refreshPairing(); // mint the first pairing code
  }

  async stop(): Promise<void> {
    this.push({ enabled: false, status: "off", pairingCode: undefined, pairingExpiresAt: undefined });
    try { rmSync(TUNNEL_MARKER, { force: true }); } catch { /* */ }
    if (this.pairTimer) { clearTimeout(this.pairTimer); this.pairTimer = null; }
    this.killChild("frpc");
    this.killChild("mcpHttp");
    await this.unpair(); // best-effort: block token refresh ("off means off")
    log(TAG, "tunnel down");
  }

  // --- children -------------------------------------------------------------
  private startMcpHttp(): void {
    const tsxBin = resolve(this.deps.packageRoot, "sinain-core", "node_modules", ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx");
    const entry = resolve(this.deps.packageRoot, "sinain-mcp-server", "index.ts");
    this.mcpHttp = spawn(tsxBin, [entry], {
      env: {
        ...process.env,
        MCP_TRANSPORT: "http",
        MCP_HTTP_PORT: String(MCP_HTTP_PORT),
        SINAIN_CORE_URL: process.env.SINAIN_CORE_URL || `http://localhost:${this.deps.corePort}`,
        SINAIN_WORKSPACE: this.deps.workspace,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.mcpHttp.stderr && this.pipe(this.mcpHttp.stderr, (l) => debug(TAG, `mcp-http: ${l}`));
    this.mcpHttp.on("exit", (code) => {
      this.mcpHttp = null;
      if (this.state.enabled) this.fail(`MCP HTTP server exited (${code})`);
    });
  }

  private startFrpc(frpcBin: string, id: TunnelIdentity): void {
    const cfgPath = this.writeFrpcConfig(id);
    this.frpc = spawn(frpcBin, ["-c", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    const onLine = (l: string) => {
      debug(TAG, `frpc: ${l}`);
      if (/start proxy success/i.test(l)) log(TAG, "frpc proxy registered");
      if (/start error|rejected|reject_reason|login to server failed/i.test(l)) {
        this.push({ error: `frpc: ${l.slice(0, 120)}` });
      }
    };
    this.frpc.stdout && this.pipe(this.frpc.stdout, onLine);
    this.frpc.stderr && this.pipe(this.frpc.stderr, onLine);
    this.frpc.on("exit", (code) => {
      this.frpc = null;
      if (this.state.enabled) this.fail(`frpc exited (${code})`);
    });
  }

  private writeFrpcConfig(id: TunnelIdentity): string {
    const dir = join(homedir(), ".sinain", "tmp");
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, "frpc.toml");
    const sig = signMessage(id.privateKeyPem, id.handle);
    const toml = [
      `serverAddr = ${JSON.stringify(TUNNEL_HOST)}`,
      `serverPort = ${TUNNEL_PORT}`,
      `transport.tls.enable = ${TLS_ENABLE}`,
      `loginFailExit = false`,
      `metadatas.pubkey = ${JSON.stringify(id.publicKeyPem)}`,
      `metadatas.sig = ${JSON.stringify(sig)}`,
      ``,
      `[[proxies]]`,
      `name = "sinain-mcp"`,
      `type = "http"`,
      `localIP = "127.0.0.1"`,
      `localPort = ${MCP_HTTP_PORT}`,
      `subdomain = ${JSON.stringify(id.handle)}`,
      ``,
    ].join("\n");
    writeFileSync(cfgPath, toml, { mode: 0o600 });
    return cfgPath;
  }

  private killChild(which: "frpc" | "mcpHttp"): void {
    const c = which === "frpc" ? this.frpc : this.mcpHttp;
    if (!c) return;
    try { c.kill("SIGTERM"); } catch { /* */ }
    if (which === "frpc") this.frpc = null; else this.mcpHttp = null;
  }

  private pipe(stream: NodeJS.ReadableStream, sink: (line: string) => void): void {
    createInterface({ input: stream }).on("line", sink);
  }

  private fail(msg: string): void {
    this.starting = false;
    error(TAG, msg);
    this.killChild("frpc");
    this.killChild("mcpHttp");
    this.push({ status: "error", error: msg });
  }

  // --- pairing --------------------------------------------------------------
  private async refreshPairing(): Promise<void> {
    if (!this.state.enabled || !this.identity) return;
    const id = this.identity;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(8).toString("hex");
    const sig = signMessage(id.privateKeyPem, `pair|${ts}|${nonce}`);
    try {
      const res = await fetch(`${AS_BASE}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: id.publicKeyPem, ts, nonce, sig }),
      });
      if (!res.ok) throw new Error(`AS /pair ${res.status}`);
      const { code, expires_in } = await res.json() as { code: string; expires_in: number };
      const expiresAt = Date.now() + (expires_in * 1000);
      this.push({ pairingCode: code, pairingExpiresAt: expiresAt, error: undefined });
      log(TAG, `pairing code ready (expires in ${expires_in}s)`);
      if (this.pairTimer) clearTimeout(this.pairTimer);
      this.pairTimer = setTimeout(() => { void this.refreshPairing(); },
        Math.max(10_000, expires_in * 1000 - PAIR_REFRESH_LEAD_MS));
    } catch (e: any) {
      const msg = `pairing unavailable: ${e?.message ?? e}`;
      debug(TAG, msg);
      this.push({ error: msg });
      if (this.pairTimer) clearTimeout(this.pairTimer);
      this.pairTimer = setTimeout(() => { void this.refreshPairing(); }, 15_000); // retry
    }
  }

  private async unpair(): Promise<void> {
    const id = this.identity;
    if (!id) return;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(8).toString("hex");
    const sig = signMessage(id.privateKeyPem, `unpair|${ts}|${nonce}`);
    try {
      await fetch(`${AS_BASE}/unpair`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: id.publicKeyPem, ts, nonce, sig }),
      });
    } catch { /* best-effort */ }
  }
}
