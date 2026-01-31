// ── Wire protocol types ──

export type Priority = "normal" | "high" | "urgent";

/** Bridge → Overlay: feed item */
export interface FeedMessage {
  type: "feed";
  text: string;
  priority: Priority;
  ts: number;
}

/** Bridge → Overlay: status update */
export interface StatusMessage {
  type: "status";
  audio: string;
  screen: string;
  connection: string;
}

/** Bridge → Overlay: heartbeat ping */
export interface PingMessage {
  type: "ping";
  ts: number;
}

/** Overlay → Bridge: user typed a message */
export interface UserMessage {
  type: "message";
  text: string;
}

/** Overlay → Bridge: command (mute_audio, toggle_screen, etc.) */
export interface CommandMessage {
  type: "command";
  action: string;
}

/** Overlay → Bridge: heartbeat pong */
export interface PongMessage {
  type: "pong";
  ts: number;
}

export type OutboundMessage = FeedMessage | StatusMessage | PingMessage;
export type InboundMessage = UserMessage | CommandMessage | PongMessage;

// ── Internal types ──

export interface TranscriptEntry {
  text: string;
  source: string;
  ts: number;
}

export interface BridgeConfig {
  openclawGatewayUrl: string;
  openclawToken: string;
  openclawSessionKey: string;
  wsPort: number;
  relayMinIntervalMs: number;
}

export interface BridgeState {
  audio: "active" | "muted";
  screen: "active" | "off";
  connection: "connected" | "disconnected" | "connecting";
}
