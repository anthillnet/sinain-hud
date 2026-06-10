import { execFile } from "node:child_process";
import type { InboundMessage, ResponseSize } from "../types.js";
import type { WsHandler } from "./ws-handler.js";
import type { AudioPipeline } from "../audio/pipeline.js";
import type { CoreConfig } from "../types.js";
import { WebSocket } from "ws";
import { loadedEnvPath } from "../config.js";
import { log } from "../log.js";

const TAG = "cmd";

export interface CommandDeps {
  wsHandler: WsHandler;
  systemAudioPipeline: AudioPipeline;
  micPipeline: AudioPipeline | null;
  config: CoreConfig;
  onUserMessage: (text: string) => Promise<void>;
  /** Queue a user command to augment the next escalation */
  onUserCommand: (text: string) => void;
  /** Spawn a background agent task. regionId present when a region eye initiated it. */
  onSpawnCommand?: (text: string, regionId?: string) => void;
  /** Toggle screen capture — returns new state */
  onToggleScreen: () => boolean;
  /** Toggle escalation pause/resume — returns true if now active */
  onToggleEscalation: () => boolean;
  /** Set the agent for a lane. agent="" means Off (lane disabled).
   *  Returns { ok: false, error } if agent isn't in the current roster. */
  onSetAgent?: (lane: "escalation" | "spawn", agent: string) => { ok: boolean; error?: string };
  /** Start the local bare-agent runner for the selected escalation agent. */
  onStartLocalAgent?: (agent?: string) => {
    ok: boolean;
    agent?: string;
    alreadyRunning?: boolean;
    error?: string;
  };
}

/**
 * Handle overlay commands and user messages.
 * Registers as the WS handler's onIncoming callback.
 */
export function setupCommands(deps: CommandDeps): void {
  const { wsHandler } = deps;

  wsHandler.onIncoming(async (msg: InboundMessage, _client: WebSocket) => {
    switch (msg.type) {
      case "message": {
        log(TAG, `routing user message to OpenClaw`);
        try {
          await deps.onUserMessage(msg.text);
        } catch {
          wsHandler.broadcast("\u26a0 Failed to reach Sinain. Check gateway connection.", "high");
        }
        break;
      }
      case "user_command": {
        log(TAG, `user command received: "${msg.text.slice(0, 60)}"`);
        // Echo user message to all overlay clients as a feed item
        wsHandler.broadcastRaw({
          type: "feed",
          text: msg.text,
          priority: "normal",
          ts: Date.now(),
          channel: "agent",
          sender: "user",
        } as any);
        // Show thinking indicator
        wsHandler.broadcastRaw({ type: "thinking", active: true } as any);
        deps.onUserCommand(msg.text);
        break;
      }
      case "spawn_command": {
        const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text;
        const regionId = typeof msg.regionId === "string" && msg.regionId ? msg.regionId : undefined;
        log(TAG, `spawn command received: "${preview}"${regionId ? ` (region=${regionId})` : ""}`);
        // Echo spawn command to all overlay clients as a feed item (green in
        // UI). Region thread messages carry regionId → overlay routes the
        // echo to that region's tab instead of the main feed.
        wsHandler.broadcastRaw({
          type: "feed",
          text: `⚡ ${msg.text}`,
          priority: "normal",
          ts: Date.now(),
          channel: "agent",
          sender: "spawn",
          ...(regionId ? { regionId } : {}),
        } as any);
        if (deps.onSpawnCommand) {
          deps.onSpawnCommand(msg.text, regionId);
        } else {
          log(TAG, `spawn command ignored — no handler configured`);
          wsHandler.broadcast(`⚠ Spawn not available (no agent gateway connected)`, "normal");
        }
        break;
      }
      case "spawn_reply": {
        const { taskId, text } = msg as any;
        log(TAG, `spawn reply for ${taskId}: "${(text || "").slice(0, 60)}"`);
        // Forward to the /spawn/reply HTTP endpoint internally
        fetch(`http://localhost:${deps.config.port}/spawn/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, text }),
        }).catch(() => {});
        break;
      }
      case "spawn_permission_reply": {
        const { taskId, decision } = msg as any;
        log(TAG, `spawn permission reply for ${taskId}: ${decision}`);
        fetch(`http://localhost:${deps.config.port}/spawn/permission-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, decision }),
        }).catch(() => {});
        break;
      }
      case "command": {
        handleCommand(msg, deps);
        log(TAG, `command processed: ${msg.action}`);
        break;
      }
    }
  });
}

const VALID_RESPONSE_SIZES = new Set<ResponseSize>(["small", "medium", "large"]);

function handleCommand(msg: InboundMessage & { action: string }, deps: CommandDeps): void {
  const { wsHandler, systemAudioPipeline, micPipeline } = deps;
  const action = msg.action;

  switch (action) {
    case "toggle_audio": {
      const isSck = systemAudioPipeline.getCaptureCommand() === "screencapturekit";
      if (systemAudioPipeline.isRunning() && !systemAudioPipeline.isMuted()) {
        if (isSck) {
          // sck-capture also captures screen — keep process alive, just mute audio
          systemAudioPipeline.mute();
          log(TAG, "system audio muted (sck-capture still running for screen)");
        } else {
          // sox/ffmpeg are audio-only — full stop
          systemAudioPipeline.stop();
          log(TAG, "system audio stopped");
        }
        wsHandler.broadcast("System audio muted", "normal");
      } else if (systemAudioPipeline.isRunning() && systemAudioPipeline.isMuted()) {
        systemAudioPipeline.unmute();
        wsHandler.broadcast("System audio unmuted", "normal");
        log(TAG, "system audio unmuted");
      } else {
        systemAudioPipeline.start();
        wsHandler.broadcast("System audio capture started", "normal");
        log(TAG, "system audio started (was not running)");
      }
      break;
    }
    case "toggle_mic": {
      if (!micPipeline) {
        wsHandler.broadcast("\u26a0 Mic not enabled (set MIC_ENABLED=true)", "normal");
        log(TAG, "toggle_mic: mic not enabled");
        break;
      }
      if (micPipeline.isRunning()) {
        micPipeline.stop();
        wsHandler.broadcast("Mic capture stopped", "normal");
        log(TAG, "mic toggled OFF");
      } else {
        micPipeline.start();
        wsHandler.broadcast("Mic capture started", "normal");
        log(TAG, "mic toggled ON");
      }
      break;
    }
    case "toggle_screen": {
      const nowActive = deps.onToggleScreen();
      wsHandler.broadcast(
        nowActive ? "Screen capture started" : "Screen capture stopped",
        "normal"
      );
      log(TAG, `screen toggled ${nowActive ? "ON" : "OFF"}`);
      break;
    }
    case "toggle_escalation": {
      const nowActive = deps.onToggleEscalation();
      wsHandler.updateState({ escalation: nowActive ? "active" : "paused" });
      wsHandler.broadcast(
        nowActive ? "Escalations resumed" : "Escalations paused — context still accumulating",
        "normal"
      );
      log(TAG, `escalation toggled ${nowActive ? "ON" : "OFF"}`);
      break;
    }
    case "set_response_size": {
      const size = (msg as any).responseSize as string;
      if (VALID_RESPONSE_SIZES.has(size as ResponseSize)) {
        wsHandler.updateState({ responseSize: size as ResponseSize });
        log(TAG, `response size set to ${size}`);
      } else {
        log(TAG, `invalid response size: ${size}`);
      }
      break;
    }
    case "set_agent": {
      const lane = (msg as any).lane as "escalation" | "spawn" | undefined;
      const agent = (msg as any).agent;
      if (lane !== "escalation" && lane !== "spawn") {
        log(TAG, `set_agent: invalid lane "${lane}"`);
        break;
      }
      if (typeof agent !== "string") {
        log(TAG, `set_agent: missing or non-string agent field`);
        break;
      }
      if (!deps.onSetAgent) {
        log(TAG, `set_agent: no handler wired`);
        break;
      }
      const result = deps.onSetAgent(lane, agent);
      if (!result.ok) {
        wsHandler.broadcast(`⚠ ${result.error ?? "set_agent failed"}`, "normal");
      }
      log(TAG, `set_agent lane=${lane} agent=${agent || "<off>"} (ok=${result.ok})`);
      break;
    }
    case "start_local_agent": {
      const agent = (msg as any).agent;
      if (agent !== undefined && typeof agent !== "string") {
        log(TAG, "start_local_agent: invalid agent field");
        break;
      }
      if (!deps.onStartLocalAgent) {
        log(TAG, "start_local_agent: no handler wired");
        wsHandler.broadcast("⚠ Local agent launcher is not available", "high");
        break;
      }
      const result = deps.onStartLocalAgent(agent);
      if (!result.ok) {
        wsHandler.broadcast(`⚠ ${result.error ?? "Failed to start local agent"}`, "high");
        log(TAG, `start_local_agent failed: ${result.error ?? "unknown error"}`);
      } else if (result.alreadyRunning) {
        wsHandler.broadcast(`Local agent already running: ${result.agent ?? "default"}`, "normal");
        log(TAG, `start_local_agent ignored; already running (${result.agent ?? "default"})`);
      } else {
        wsHandler.broadcast(`Starting local escalation agent: ${result.agent ?? "default"}`, "normal");
        log(TAG, `start_local_agent launched (${result.agent ?? "default"})`);
      }
      break;
    }
    case "open_settings": {
      const envPath = loadedEnvPath || `${process.env.HOME || process.env.USERPROFILE}/.sinain/.env`;
      const cmd = process.platform === "win32" ? "notepad" : "open";
      const args = process.platform === "win32" ? [envPath] : ["-t", envPath];
      execFile(cmd, args, (err) => {
        if (err) log(TAG, `open_settings failed: ${err.message}`);
      });
      log(TAG, `open_settings: ${envPath}`);
      break;
    }
    default:
      log(TAG, `unhandled command: ${action}`);
  }
}
