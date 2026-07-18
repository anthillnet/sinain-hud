import { execFile } from "node:child_process";
import type { InboundMessage, ResponseSize } from "../types.js";
import type { WsHandler } from "./ws-handler.js";
import type { AudioPipeline } from "../audio/pipeline.js";
import type { CoreConfig } from "../types.js";
import { WebSocket } from "ws";
import { loadedEnvPath } from "../config.js";
import { resolveWritableAgentsConfigPath } from "../agents-loader.js";
import { log, preview } from "../log.js";

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
  /** Fork MAIN into a new thread: mints a thread id and stores a seed built
   *  from the MAIN transcript + digest. Returns the new thread's identity. */
  onForkMain?: () => { id: string; label: string };
  /** Stash a thread's conversation transcript for a pending handoff — the
   *  destination agent's next seed picks it up so it continues the thread.
   *  key = regionId for a region thread, "main" for the main thread. */
  onSetHandoffContext?: (key: string, transcript: string) => void;
  /** Set a per-thread chat-agent override (handoff). key = regionId or "main";
   *  agent="" clears it (thread falls back to the global lane). */
  onSetThreadAgent?: (key: string, agent: string) => void;
  /** User drag-selected a screen region — create a manual ROI from it. */
  onRegionSelect?: (sel: { x: number; y: number; w: number; h: number; screenW: number; screenH: number }) => void;
  /** Frontmost app changed (fast NSWorkspace signal) — instant ROI restore. */
  onAppFocus?: (app: string) => void;
  /** Toggle screen capture — returns new state */
  onToggleScreen: () => boolean;
  /** Toggle escalation pause/resume — returns true if now active */
  onToggleEscalation: () => boolean;
  /** Idempotent set of escalation enabled/paused — returns true if now active.
   *  Unlike onToggleEscalation (a flip), an explicit set can't desync into
   *  flipping the wrong way when the overlay's displayed state lags core. */
  onSetEscalationEnabled?: (enabled: boolean) => boolean;
  /** Set ambient/idle (unsolicited) HUD messages on/off. Opt-in, default off,
   *  persisted, and independent of escalation mode — returns the new state. */
  onSetIdleMessagesEnabled?: (enabled: boolean) => boolean;
  /** Set the agent for a lane. agent="" means Off (lane disabled).
   *  Returns { ok: false, error } if agent isn't in the current roster. */
  onSetAgent?: (lane: "escalation" | "terminal", agent: string) => { ok: boolean; error?: string };
  /** Toggle the ChatGPT network harness (public-tunnel exposure) at runtime. */
  onSetChatgptHarness?: (enabled: boolean) => void;
  onMcpTunnelSignin?: () => void;
  onMcpTunnelSignout?: () => void;
  /** Toggle issue auto-detection (Grammarly mode regions) at runtime.
   *  The overlay's settings toggle is the source of truth. */
  onSetAutoDetect?: (enabled: boolean) => void;
  /** Toggle the optional burst-lane brief injected when an agent starts. */
  onSetAgentLlmBrief?: (enabled: boolean) => void;
  /** Hold ambient escalations for [ms] — user is actively interacting. */
  onUserBusy?: (ms: number) => void;
  /** Start the local bare-agent runner for the selected escalation agent. */
  onStartLocalAgent?: (agent?: string) => {
    ok: boolean;
    agent?: string;
    alreadyRunning?: boolean;
    error?: string;
  };
  /** (Re)start the resident chat sidecar — overlay Run button when the
   *  built-in sinain chat lane is selected but unreachable. */
  onRestartChatSidecar?: () => { ok: boolean; error?: string };
  /** Resolve an approval requested by an attached agent CLI. */
  onAgentApprovalReply?: (id: string, behavior: "allow" | "deny" | "always", answer?: string) => void;
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
        log(TAG, `user command received: ${preview(msg.text, 60)}`);
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
        // Echo the message back to overlay clients. A thread send (regionId
        // set) is just the user speaking in that thread's chat — echo it as
        // the user, verbatim. Legacy non-thread spawn commands keep the ⚡
        // prefix + spawn sender for the main feed.
        wsHandler.broadcastRaw({
          type: "feed",
          text: regionId ? msg.text : `⚡ ${msg.text}`,
          priority: "normal",
          ts: Date.now(),
          channel: "agent",
          sender: regionId ? "user" : "spawn",
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
      case "region_select": {
        const sel = msg as any;
        log(TAG, `region select: ${sel.w}x${sel.h} at (${sel.x},${sel.y})`);
        deps.onRegionSelect?.({ x: sel.x, y: sel.y, w: sel.w, h: sel.h, screenW: sel.screenW, screenH: sel.screenH });
        break;
      }
      case "app_focus": {
        deps.onAppFocus?.((msg as any).app ?? "");
        break;
      }
      case "fork_main": {
        if (!deps.onForkMain) break;
        const fork = deps.onForkMain();
        log(TAG, `MAIN forked → ${fork.id}`);
        // Open the thread tab on every client — rides the thread-status
        // channel (regionId keys the tab, label titles it).
        wsHandler.broadcastRaw({
          type: "spawn_task",
          taskId: fork.id,
          label: fork.label,
          status: "completed",
          startedAt: Date.now(),
          regionId: fork.id,
        } as any);
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
      case "agent_approval_reply": {
        deps.onAgentApprovalReply?.(
          msg.id,
          msg.behavior,
          typeof msg.answer === "string" ? msg.answer : undefined,
        );
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
    case "set_escalation_enabled": {
      const enabled = (msg as any).enabled;
      if (typeof enabled !== "boolean") {
        log(TAG, `set_escalation_enabled: missing or non-boolean enabled field`);
        break;
      }
      if (!deps.onSetEscalationEnabled) {
        log(TAG, `set_escalation_enabled: no handler wired`);
        break;
      }
      const nowActive = deps.onSetEscalationEnabled(enabled);
      wsHandler.updateState({ escalation: nowActive ? "active" : "paused" });
      wsHandler.broadcast(
        nowActive ? "Escalations resumed" : "Escalations paused — context still accumulating",
        "normal"
      );
      log(TAG, `escalation set ${nowActive ? "ON" : "OFF"}`);
      break;
    }
    case "set_idle_messages_enabled": {
      const enabled = (msg as any).enabled;
      if (typeof enabled !== "boolean") {
        log(TAG, `set_idle_messages_enabled: missing or non-boolean enabled field`);
        break;
      }
      if (!deps.onSetIdleMessagesEnabled) {
        log(TAG, `set_idle_messages_enabled: no handler wired`);
        break;
      }
      const nowOn = deps.onSetIdleMessagesEnabled(enabled);
      wsHandler.updateState({ idleMessages: nowOn ? "on" : "off" });
      wsHandler.broadcast(
        nowOn
          ? "Idle messages ON — Sinain will message you proactively (uses API tokens)"
          : "Idle messages OFF",
        "normal"
      );
      log(TAG, `idle messages set ${nowOn ? "ON" : "OFF"}`);
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
      const lane = (msg as any).lane as "escalation" | "terminal" | undefined;
      const agent = (msg as any).agent;
      if (lane !== "escalation" && lane !== "terminal") {
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

    case "set_chatgpt_harness": {
      const enabled = (msg as any).enabled === true;
      deps.onSetChatgptHarness?.(enabled);
      log(TAG, `set_chatgpt_harness enabled=${enabled}`);
      break;
    }

    case "mcp_tunnel_signin": {
      deps.onMcpTunnelSignin?.();
      log(TAG, "mcp_tunnel_signin");
      break;
    }

    case "mcp_tunnel_signout": {
      deps.onMcpTunnelSignout?.();
      log(TAG, "mcp_tunnel_signout");
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
    case "restart_chat_sidecar": {
      if (!deps.onRestartChatSidecar) {
        log(TAG, "restart_chat_sidecar: no handler wired");
        wsHandler.broadcast("⚠ sinain-chat launcher is not available", "high");
        break;
      }
      const result = deps.onRestartChatSidecar();
      if (!result.ok) {
        wsHandler.broadcast(`⚠ ${result.error ?? "Failed to start sinain-chat"}`, "high");
        log(TAG, `restart_chat_sidecar failed: ${result.error ?? "unknown error"}`);
      } else {
        wsHandler.broadcast("Starting sinain-chat…", "normal");
        log(TAG, "restart_chat_sidecar launched");
      }
      break;
    }
    case "set_handoff_context": {
      const key = String((msg as any).key ?? "").trim();
      const transcript = String((msg as any).transcript ?? "");
      if (!key || !transcript.trim()) {
        log(TAG, `set_handoff_context: missing key/transcript`);
        break;
      }
      if (deps.onSetHandoffContext) {
        deps.onSetHandoffContext(key, transcript);
        log(TAG, `set_handoff_context: ${key} (${transcript.length} chars)`);
      } else {
        log(TAG, `set_handoff_context: no handler wired`);
      }
      break;
    }
    case "set_thread_agent": {
      const key = String((msg as any).key ?? "").trim();
      const agent = String((msg as any).agent ?? "");
      if (!key) {
        log(TAG, `set_thread_agent: missing key`);
        break;
      }
      if (deps.onSetThreadAgent) {
        deps.onSetThreadAgent(key, agent);
      } else {
        log(TAG, `set_thread_agent: no handler wired`);
      }
      break;
    }
    case "set_auto_detect": {
      const enabled = (msg as any).enabled === true;
      if (deps.onSetAutoDetect) {
        deps.onSetAutoDetect(enabled);
        log(TAG, `auto-detect issues ${enabled ? "enabled" : "disabled"}`);
      } else {
        log(TAG, `set_auto_detect: no handler wired`);
      }
      break;
    }
    case "set_agent_llm_brief": {
      const enabled = (msg as any).enabled;
      if (typeof enabled !== "boolean") {
        log(TAG, `set_agent_llm_brief: missing or non-boolean enabled field`);
        break;
      }
      if (deps.onSetAgentLlmBrief) {
        deps.onSetAgentLlmBrief(enabled);
        log(TAG, `agent LLM brief ${enabled ? "enabled" : "disabled"}`);
      } else {
        log(TAG, `set_agent_llm_brief: no handler wired`);
      }
      break;
    }
    case "user_busy": {
      // Overlay signals active user interaction (visible thread terminal,
      // throttled). Holds ambient escalations; user commands still pass.
      // seconds <= 0 releases the quiet window immediately (user left the
      // terminal view); absent defaults to 120.
      const raw = Number((msg as any).seconds);
      const seconds = isNaN(raw) ? 120 : Math.min(Math.max(raw, 0), 600);
      if (deps.onUserBusy) {
        deps.onUserBusy(seconds * 1000);
      } else {
        log(TAG, `user_busy: no handler wired`);
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
    case "open_roster_config": {
      // Open the agents.json roster file in a text editor — mirrors
      // open_settings (.env), seeding a writable copy if none exists yet.
      const cfgPath = resolveWritableAgentsConfigPath();
      const cmd = process.platform === "win32" ? "notepad" : "open";
      const args = process.platform === "win32" ? [cfgPath] : ["-t", cfgPath];
      execFile(cmd, args, (err) => {
        if (err) log(TAG, `open_roster_config failed: ${err.message}`);
      });
      log(TAG, `open_roster_config: ${cfgPath}`);
      break;
    }
    default:
      log(TAG, `unhandled command: ${action}`);
  }
}
