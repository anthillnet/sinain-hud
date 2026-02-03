import type { InboundMessage } from "../types.js";
import type { WsHandler } from "./ws-handler.js";
import type { AudioPipeline } from "../audio/pipeline.js";
import type { CoreConfig } from "../types.js";
import { WebSocket } from "ws";
import { log } from "../log.js";

const TAG = "cmd";

export interface CommandDeps {
  wsHandler: WsHandler;
  audioPipeline: AudioPipeline;
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
  const { wsHandler, audioPipeline, config } = deps;

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
  const { wsHandler, audioPipeline, config } = deps;

  switch (action) {
    case "toggle_audio": {
      if (audioPipeline.isRunning()) {
        audioPipeline.stop();
        wsHandler.broadcast("Audio capture stopped", "normal");
        log(TAG, "audio toggled OFF");
      } else {
        audioPipeline.start();
        wsHandler.broadcast("Audio capture started", "normal");
        log(TAG, "audio toggled ON");
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
      const current = audioPipeline.getDevice();
      const alt = config.audioAltDevice;
      const next = current === config.audioConfig.device ? alt : config.audioConfig.device;
      audioPipeline.switchDevice(next);
      wsHandler.broadcast(`Audio device \u2192 ${next}`, "normal");
      log(TAG, `audio device switched: ${current} \u2192 ${next}`);
      break;
    }
    default:
      log(TAG, `unhandled command: ${action}`);
  }
}
