import { execFile } from "node:child_process";
import type { InboundMessage } from "../types.js";
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
  /** Spawn a background agent task */
  onSpawnCommand?: (text: string) => void;
  /** Toggle screen capture — returns new state */
  onToggleScreen: () => boolean;
  /** Toggle trait voices — returns new enabled state */
  onToggleTraits?: () => boolean;
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
        log(TAG, `spawn command received: "${preview}"`);
        // Echo spawn command to all overlay clients as a feed item (green in UI)
        wsHandler.broadcastRaw({
          type: "feed",
          text: `⚡ ${msg.text}`,
          priority: "normal",
          ts: Date.now(),
          channel: "agent",
          sender: "spawn",
        } as any);
        if (deps.onSpawnCommand) {
          deps.onSpawnCommand(msg.text);
        } else {
          log(TAG, `spawn command ignored — no handler configured`);
          wsHandler.broadcast(`⚠ Spawn not available (no agent gateway connected)`, "normal");
        }
        break;
      }
      case "command": {
        handleCommand(msg.action, deps);
        log(TAG, `command processed: ${msg.action}`);
        break;
      }
    }
  });
}

function handleCommand(action: string, deps: CommandDeps): void {
  const { wsHandler, systemAudioPipeline, micPipeline } = deps;

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
    case "toggle_traits": {
      if (!deps.onToggleTraits) {
        wsHandler.broadcast("Trait voices not configured", "normal");
        break;
      }
      const nowEnabled = deps.onToggleTraits();
      wsHandler.updateState({ traits: nowEnabled ? "active" : "off" });
      wsHandler.broadcast(`Trait voices ${nowEnabled ? "on" : "off"}`, "normal");
      log(TAG, `traits toggled ${nowEnabled ? "ON" : "OFF"}`);
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
