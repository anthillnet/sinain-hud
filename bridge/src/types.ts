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

// ── Audio pipeline types ──

export interface AudioPipelineConfig {
  device: string;
  sampleRate: number;
  channels: number;
  chunkDurationMs: number;
  vadEnabled: boolean;
  vadThreshold: number;
  captureCommand: "sox" | "ffmpeg";
  autoStart: boolean;
  gainDb: number;
}

export interface TranscriptionConfig {
  backend: "aws-gemini" | "openrouter" | "whisper";
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  openrouterApiKey: string;
  geminiModel: string;
  refineIntervalMs: number;
  language: string;
}

export interface AudioChunk {
  buffer: Buffer;
  source: string;
  ts: number;
  durationMs: number;
  energy: number;
}

export interface TranscriptResult {
  text: string;
  source: "aws" | "gemini" | "openrouter" | "whisper";
  refined: boolean;
  confidence: number;
  ts: number;
}

// ── Trigger engine types ──

export interface TriggerConfig {
  enabled: boolean;
  model: string;
  apiKey: string;
}

export interface TriggerResult {
  shouldEscalate: boolean;
  trigger: string;
  priority: Priority;
  summary: string;
}

// ── Sense (screen capture) types ──

export interface SenseConfig {
  enabled: boolean;
  pollIntervalMs: number;
}

// ── Bridge config ──

export interface BridgeConfig {
  openclawGatewayUrl: string;
  openclawToken: string;
  openclawSessionKey: string;
  wsPort: number;
  relayMinIntervalMs: number;
  audioConfig: AudioPipelineConfig;
  audioAltDevice: string;
  transcriptionConfig: TranscriptionConfig;
  triggerConfig: TriggerConfig;
  senseConfig: SenseConfig;
}

export interface BridgeState {
  audio: "active" | "muted";
  screen: "active" | "off";
  connection: "connected" | "disconnected" | "connecting";
}
