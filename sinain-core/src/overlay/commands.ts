import type { InboundMessage } from "../types.js";
import type { WsHandler } from "./ws-handler.js";
import type { AudioPipeline } from "../audio/pipeline.js";
import type { CoreConfig } from "../types.js";
import { WebSocket } from "ws";
import { log } from "../log.js";

const TAG = "cmd";

export interface CommandDeps {
  wsHandler: WsHandler;
  systemAudioPipeline: AudioPipeline;
  micPipeline: AudioPipeline | null;
  config: CoreConfig;
  onUserMessage: (text: string) => Promise<void>;
  /** Toggle screen capture — returns new state */
  onToggleScreen: () => boolean;
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
      case "command": {
        handleCommand(msg.action, deps);
        log(TAG, `command processed: ${msg.action}`);
        break;
      }
    }
  });
}

function handleCommand(action: string, deps: CommandDeps): void {
  const { wsHandler, systemAudioPipeline, micPipeline, config } = deps;

  switch (action) {
    case "toggle_audio": {
      if (systemAudioPipeline.isRunning() && !systemAudioPipeline.isMuted()) {
        systemAudioPipeline.mute();
        wsHandler.broadcast("System audio muted", "normal");
        log(TAG, "system audio muted (sck-capture still running)");
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
    case "switch_device": {
      const current = systemAudioPipeline.getDevice();
      const alt = config.audioAltDevice;
      const next = current === config.audioConfig.device ? alt : config.audioConfig.device;
      systemAudioPipeline.switchDevice(next);
      wsHandler.broadcast(`Audio device \u2192 ${next}`, "normal");
      log(TAG, `audio device switched: ${current} \u2192 ${next}`);
      break;
    }
    default:
      log(TAG, `unhandled command: ${action}`);
  }
}
