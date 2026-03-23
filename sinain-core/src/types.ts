// ── Wire protocol types (overlay ↔ sinain-core) ──

export type Priority = "normal" | "high" | "urgent";
export type FeedChannel = "stream" | "agent";

/** sinain-core → Overlay: feed item */
export interface FeedMessage {
  type: "feed";
  text: string;
  priority: Priority;
  ts: number;
  channel: FeedChannel;
}

/** sinain-core → Overlay: status update */
export interface StatusMessage {
  type: "status";
  audio: string;
  mic: string;
  screen: string;
  connection: string;
}

/** sinain-core → Overlay: heartbeat ping */
export interface PingMessage {
  type: "ping";
  ts: number;
}

/** sinain-core → Overlay: spawn task lifecycle update */
export type SpawnTaskStatus = "spawned" | "polling" | "completed" | "failed" | "timeout";

export interface SpawnTaskMessage {
  type: "spawn_task";
  taskId: string;
  label: string;
  status: SpawnTaskStatus;
  startedAt: number;
  completedAt?: number;
  resultPreview?: string;
}

/** Overlay → sinain-core: user typed a message */
export interface UserMessage {
  type: "message";
  text: string;
}

/** Overlay → sinain-core: command (toggle_audio, toggle_screen, etc.) */
export interface CommandMessage {
  type: "command";
  action: string;
}

/** Overlay → sinain-core: heartbeat pong */
export interface PongMessage {
  type: "pong";
  ts: number;
}

/** Overlay → sinain-core: process profiling metrics */
export interface ProfilingMessage {
  type: "profiling";
  rssMb: number;
  uptimeS: number;
  ts: number;
}

/** Overlay → sinain-core: user command to augment next escalation */
export interface UserCommandMessage {
  type: "user_command";
  text: string;
}

/** Overlay → sinain-core: spawn a background agent task */
export interface SpawnCommandMessage {
  type: "spawn_command";
  text: string;
}

export type OutboundMessage = FeedMessage | StatusMessage | PingMessage | SpawnTaskMessage;
export type InboundMessage = UserMessage | CommandMessage | PongMessage | ProfilingMessage | UserCommandMessage | SpawnCommandMessage;

/** Abstraction for user commands (text now, voice later). */
export interface UserCommand {
  text: string;
  ts: number;
  source: "text" | "voice";
}

// ── Feed buffer types ──

export interface FeedItem {
  id: number;
  text: string;
  priority: Priority;
  ts: number;
  source: "audio" | "sense" | "agent" | "openclaw" | "system";
  channel: FeedChannel;
  audioSource?: AudioSourceTag;
}

// ── Sense buffer types ──

export interface SenseEvent {
  id: number;
  type: "text" | "visual" | "context";
  ts: number;
  ocr: string;
  imageData?: string;   // base64 JPEG thumbnail (stripped from older events)
  imageBbox?: number[]; // [x, y, w, h] of the captured region
  meta: {
    ssim: number;
    app: string;
    windowTitle?: string;
    screen: number;
  };
  receivedAt: number;
}

// ── Audio pipeline types ──

export type AudioSourceTag = "system" | "mic";

export interface AudioPipelineConfig {
  device: string;
  sampleRate: number;
  channels: number;
  chunkDurationMs: number;
  vadEnabled: boolean;
  vadThreshold: number;
  captureCommand: "sox" | "ffmpeg" | "screencapturekit";
  autoStart: boolean;
  gainDb: number;
}

export interface TraitConfig {
  enabled: boolean;
  configPath: string;   // path to ~/.sinain/traits.json
  entropyHigh: boolean; // Phase 2: boosts entropy roll to 15%
  logDir: string;       // path to ~/.sinain-core/traits/
}

export interface TraitLogEntry {
  ts: string;
  tickId: number;
  enabled: boolean;
  voice: string;
  voice_stat: number;
  voice_confidence: number;
  activation_scores: Record<string, number>;
  context_app: string;
  hud_length: number;
  synthesis: boolean;
}


export interface AudioChunk {
  buffer: Buffer;
  source: string;
  ts: number;
  durationMs: number;
  energy: number;
  audioSource: AudioSourceTag;
}

// ── Transcription types ──

export type TranscriptionBackend = "openrouter" | "local";

export interface TranscriptionConfig {
  backend: TranscriptionBackend;
  openrouterApiKey: string;
  geminiModel: string;
  language: string;
  /** Local whisper-cpp settings (only used when backend=local) */
  local: {
    bin: string;
    modelPath: string;
    language: string;
    timeoutMs: number;
  };
}

export interface TranscriptResult {
  text: string;
  source: "openrouter" | "whisper";
  refined: boolean;
  confidence: number;
  ts: number;
  audioSource: AudioSourceTag;
}

// ── Recorder types ──

export interface RecordCommand {
  command: "start" | "stop";
  label?: string;
}

export interface RecorderStatus {
  recording: boolean;
  label: string | null;
  startedAt: number | null;
  segments: number;
  durationMs: number;
}

export interface StopResult {
  title: string;
  transcript: string;
  segments: number;
  durationS: number;
}

// ── Agent types ──

export type EscalationMode = "off" | "selective" | "focus" | "rich";
export type ContextRichness = "lean" | "standard" | "rich";

export interface AgentConfig {
  enabled: boolean;
  model: string;
  visionModel: string;
  visionEnabled: boolean;
  localVisionEnabled: boolean;
  localVisionModel: string;
  localVisionUrl: string;
  localVisionTimeout: number;
  openrouterApiKey: string;
  maxTokens: number;
  temperature: number;
  pushToFeed: boolean;
  debounceMs: number;
  maxIntervalMs: number;
  cooldownMs: number;
  maxAgeMs: number;
  fallbackModels: string[];
  /** Maximum entries to keep in agent history buffer (default: 50) */
  historyLimit: number;
}

export interface AgentResult {
  hud: string;
  digest: string;
  record?: RecordCommand;
  task?: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  parsedOk: boolean;
  voice?: string;
  voice_stat?: number;
  voice_confidence?: number;
}

export interface AgentEntry extends AgentResult {
  id: number;
  ts: number;
  pushed: boolean;
  contextFreshnessMs: number | null;
  context: {
    currentApp: string;
    appHistory: string[];
    audioCount: number;
    screenCount: number;
  };
}

// ── Context window ──

export interface RichnessPreset {
  maxScreenEvents: number;
  maxAudioEntries: number;
  maxOcrChars: number;
  maxTranscriptChars: number;
  maxImages: number;
}

export interface ContextWindow {
  audio: FeedItem[];
  screen: SenseEvent[];
  images?: { data: string; app: string; ts: number }[];
  currentApp: string;
  appHistory: { app: string; ts: number }[];
  audioCount: number;
  screenCount: number;
  windowMs: number;
  newestEventTs: number;
  preset: RichnessPreset;
}

// ── Escalation types ──

export type EscalationTransport = "ws" | "http" | "auto";

export interface EscalationConfig {
  mode: EscalationMode;
  cooldownMs: number;
  staleMs: number;  // force escalation after this many ms of silence (0 = disabled)
  transport: EscalationTransport;
}

export interface OpenClawConfig {
  gatewayWsUrl: string;
  gatewayToken: string;
  hookUrl: string;
  hookToken: string;
  sessionKey: string;
  phase1TimeoutMs: number;   // default: 30_000
  phase2TimeoutMs: number;   // default: 120_000
  pingIntervalMs: number;    // default: 30_000
}

// ── Trace types ──

export interface Trace {
  traceId: string;
  tickId: number;
  ts: number;
  spans: Span[];
  metrics: TraceMetrics;
}

export interface Span {
  name: string;
  startTs: number;
  endTs: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
  error?: string;
}

export interface TraceMetrics {
  totalLatencyMs: number;
  llmLatencyMs: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCost: number;
  escalated: boolean;
  escalationScore: number;
  escalationLatencyMs?: number;
  contextScreenEvents: number;
  contextAudioEntries: number;
  contextRichness: ContextRichness;
  digestLength: number;
  hudChanged: boolean;
}

export interface MetricsSummary {
  count: number;
  latencyP50: number;
  latencyP95: number;
  avgCostPerTick: number;
  totalCost: number;
}

// ── Bridge state (overlay connection) ──

export interface BridgeState {
  audio: "active" | "muted";
  mic: "active" | "muted";
  screen: "active" | "off";
  traits?: "active" | "off";
  connection: "connected" | "disconnected" | "connecting";
}

// ── Learning / feedback types ──

export interface FeedbackSignals {
  errorCleared: boolean | null;
  noReEscalation: boolean | null;
  dwellTimeMs: number | null;
  quickAppSwitch: boolean | null;
  compositeScore: number;           // -1.0 to 1.0
}

export interface FeedbackRecord {
  id: string;                        // UUID
  ts: number;
  tickId: number;
  // Input
  digest: string;
  hud: string;
  currentApp: string;
  escalationScore: number;
  escalationReasons: string[];
  codingContext: boolean;
  // Output
  escalationMessage: string;         // trimmed to 2KB
  openclawResponse: string;          // trimmed to 2KB
  responseLatencyMs: number;
  // Feedback signals (filled async)
  signals: FeedbackSignals;
  tags: string[];
}

export interface LearningConfig {
  enabled: boolean;
  feedbackDir: string;
  retentionDays: number;
}

// ── Privacy matrix types ──

export type PrivacyLevel = "full" | "redacted" | "summary" | "none";
export type PrivacyDest = "local_buffer" | "local_llm" | "triple_store" | "openrouter" | "agent_gateway";

export interface PrivacyRow {
  local_buffer: PrivacyLevel;
  local_llm: PrivacyLevel;
  triple_store: PrivacyLevel;
  openrouter: PrivacyLevel;
  agent_gateway: PrivacyLevel;
}

export interface PrivacyMatrix {
  audio_transcript: PrivacyRow;
  screen_ocr: PrivacyRow;
  screen_images: PrivacyRow;
  window_titles: PrivacyRow;
  credentials: PrivacyRow;
  metadata: PrivacyRow;
}

export interface PrivacyConfig {
  mode: string;   // "off" | "standard" | "strict" | "paranoid" | "custom"
  matrix: PrivacyMatrix;
}

// ── Full core config ──

export interface CoreConfig {
  port: number;
  audioConfig: AudioPipelineConfig;
  micConfig: AudioPipelineConfig;
  micEnabled: boolean;
  transcriptionConfig: TranscriptionConfig;
  agentConfig: AgentConfig;
  escalationConfig: EscalationConfig;
  openclawConfig: OpenClawConfig;
  situationMdPath: string;
  traceEnabled: boolean;
  traceDir: string;
  learningConfig: LearningConfig;
  traitConfig: TraitConfig;
  privacyConfig: PrivacyConfig;
}
