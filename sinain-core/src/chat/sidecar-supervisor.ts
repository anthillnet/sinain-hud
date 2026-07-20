import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";

export type ChatSidecarStatus = {
  type: "chat_status";
  state: "starting" | "running" | "degraded" | "restarting" | "failed";
  error?: string;
};

export class ChatSidecarSupervisor {
  private child: ChildProcess | null = null;
  private output: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private startedAt = 0;
  private stopping = false;
  private lastStatus = "";

  constructor(
    private readonly root: string,
    private readonly url: string,
    private readonly broadcast: (status: ChatSidecarStatus) => void,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    if (await this.probe()) {
      this.scheduleProbe();
      return;
    }
    if (await this.portListening()) {
      this.emit("failed", "sinain chat port 9610 is in use but its health probe failed");
      this.scheduleProbe();
      return;
    }
    if ((process.env.CHAT_SIDECAR_MANAGED ?? "true").toLowerCase() === "true") {
      this.spawn();
    } else {
      this.emit("failed", "sinain chat is not running (managed sidecar disabled)");
    }
    this.scheduleProbe();
  }

  restart(): { ok: boolean; error?: string } {
    if ((process.env.CHAT_SIDECAR_MANAGED ?? "true").toLowerCase() !== "true") {
      return { ok: false, error: "managed chat sidecar is disabled" };
    }
    this.failures = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.child) this.spawn();
    return { ok: true };
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.timer = this.probeTimer = null;
    if (this.child?.exitCode === null) this.child.kill("SIGTERM");
  }

  private spawn(): void {
    if (this.stopping || this.child) return;
    const dir = process.env.SINAIN_CHAT_DIR || resolve(this.root, "sinain-chat-agent");
    const script = resolve(dir, "sidecar.py");
    if (!existsSync(script)) {
      this.park("chat sidecar not found: " + script);
      return;
    }
    const venv = resolve(dir, ".venv", "bin", "python");
    const py = process.env.SINAIN_CHAT_PY || process.env.SINAIN_CHAT_PYTHON ||
      (existsSync(venv) ? venv : "python3");
    this.startedAt = Date.now();
    this.emit(this.failures ? "restarting" : "starting");
    const child = spawn(py, [script], { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const capture = (chunk: unknown) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.output.push(line);
        if (this.output.length > 5) this.output.shift();
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (err) => capture(err.message));
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      const fast = Date.now() - this.startedAt < 10_000;
      this.failures = fast ? this.failures + 1 : 0;
      const reason = this.output.at(-1) || "sinain chat exited unexpectedly";
      if (this.failures >= 5) this.park(reason);
      else {
        const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, this.failures - 1));
        this.emit("restarting", `${reason} — restarting`);
        this.timer = setTimeout(() => { this.timer = null; this.spawn(); }, delay);
      }
    });
  }

  private park(error: string): void {
    this.emit("failed", error);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.failures = 0;
      this.spawn();
    }, 5 * 60_000);
  }

  private scheduleProbe(): void {
    this.probeTimer = setInterval(async () => {
      if (await this.probe() || this.child || this.timer || this.stopping) return;
      if (!await this.portListening() &&
          (process.env.CHAT_SIDECAR_MANAGED ?? "true").toLowerCase() === "true") {
        this.spawn();
      }
    }, 5000);
  }

  private probe(): Promise<boolean> {
    return new Promise((resolveProbe) => {
      const ws = new WebSocket(this.url);
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch { /* gone */ }
        resolveProbe(value);
      };
      const timeout = setTimeout(() => finish(false), 1500);
      ws.once("open", () => ws.send(JSON.stringify({ type: "status" })));
      ws.once("message", (raw) => {
        try {
          const status = JSON.parse(String(raw)) as { state?: string; error?: string };
          if (status.state === "degraded") this.emit("degraded", status.error);
          else this.emit("running");
          finish(true);
        } catch { finish(false); }
      });
      ws.once("error", () => finish(false));
    });
  }

  private emit(state: ChatSidecarStatus["state"], error?: string): void {
    const key = `${state}:${error ?? ""}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.broadcast({ type: "chat_status", state, ...(error ? { error } : {}) });
  }

  private portListening(): Promise<boolean> {
    let port = 9610;
    try { port = Number(new URL(this.url).port) || port; } catch { /* default */ }
    return new Promise((resolveProbe) => {
      const socket = connect({ host: "127.0.0.1", port });
      const done = (up: boolean) => {
        socket.destroy();
        resolveProbe(up);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
  }
}
