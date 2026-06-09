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
  escalation?: string;
  connection: string;
  responseSize?: string;
  /** Bare-agent roster + per-lane current choice. Omitted until the bare
   *  agent has registered via POST /bareagent/register. empty-string lane
   *  values mean "Off" (lane disabled). */
  agents?: {
    available: string[];
    escalationAgent: string;
    spawnAgent: string;
    registered: boolean;
  };
}

/** sinain-core → Overlay: heartbeat ping */
export interface PingMessage {
  type: "ping";
  ts: number;
}

/** sinain-core → Overlay: spawn task lifecycle update */
export type SpawnTaskStatus = "spawned" | "polling" | "completed" | "failed" | "timeout" | "awaiting_input" | "awaiting_permission";

export interface SpawnTaskMessage {
  type: "spawn_task";
  taskId: string;
  label: string;
  status: SpawnTaskStatus;
  startedAt: number;
  completedAt?: number;
  resultPreview?: string;
  /** Question the spawn is asking the user (status=awaiting_input) */
  question?: string;
  /** Tool permission request (status=awaiting_permission) */
  permission?: { tool: string; input: Record<string, unknown> };
  /** Region eye that initiated this spawn (overlay routes status to its badge) */
  regionId?: string;
}

// ── Region highlights (Grammarly mode) ──

export type RegionAction = "fix" | "explain" | "research";

/** Raw region as emitted by the analyzer LLM (no coordinates — the LLM
 *  references the sense event it derived the issue from via sourceId). */
export interface RawRegion {
  issue: string;
  tip: string;
  action?: RegionAction;
  /** SenseEvent.id the issue was observed in (from numbered prompt lines) */
  sourceId?: number;
}

/** Tracked region with stable identity and resolved coordinates. */
export interface RegionHighlight {
  /** Stable id derived from normalized issue text (survives re-detection) */
  id: string;
  issue: string;
  tip: string;
  action?: RegionAction;
  /** [x, y, w, h] in capture-frame pixels (absent → overlay stacks in corner) */
  bbox?: [number, number, number, number];
  /** [w, h] of the capture frame bbox is expressed in (for screen scaling) */
  frameSize?: [number, number];
  /** OCR text of the source sense event (context for spawn) */
  sourceOcr?: string;
  /** App the region was detected in */
  app?: string;
}

/** sinain-core → Overlay: current set of actionable screen regions.
 *  Full-state broadcast; overlay diffs by region id. */
export interface RegionHighlightMessage {
  type: "region_highlight";
  regions: RegionHighlight[];
  ts: number;
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
  /** Region eye that initiated the spawn (status events echo it back) */
  regionId?: string;
}

/** Overlay → sinain-core: reply to a spawn question */
export interface SpawnReplyMessage {
  type: "spawn_reply";
  taskId: string;
  text: string;
}

/** Overlay → sinain-core: reply to a spawn permission request */
export interface SpawnPermissionReplyMessage {
  type: "spawn_permission_reply";
  taskId: string;
  decision: "allow" | "deny";
}

/** Cost update broadcast to overlay. */
export interface CostMessage {
  type: "cost";
  totalCost: number;
  costBySource: Record<string, number>;
  callCount: number;
  startedAt: number;
  displayEnabled: boolean;
}

/** Entry recorded by CostTracker for each LLM call. */
export interface CostEntry {
  source: "analyzer" | "transcription" | "vision";
  model: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  ts: number;
}

/** Snapshot of accumulated cost state. */
export interface CostSnapshot {
  totalCost: number;
  costBySource: Record<string, number>;
  costByModel: Record<string, number>;
  callCount: number;
  startedAt: number;
}

export type OutboundMessage = FeedMessage | StatusMessage | PingMessage | SpawnTaskMessage | CostMessage | RegionHighlightMessage;
export type InboundMessage = UserMessage | CommandMessage | PongMessage | ProfilingMessage | UserCommandMessage | SpawnCommandMessage | SpawnReplyMessage | SpawnPermissionReplyMessage;

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
  frameSize?: number[]; // [w, h] of the full capture frame (bbox coordinate space)
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
export type ResponseSize = "small" | "medium" | "large";

export type AnalysisProvider = "openrouter" | "ollama";

export interface AnalysisConfig {
  enabled: boolean;
  provider: AnalysisProvider;
  model: string;
  visionModel: string;
  endpoint: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  fallbackModels: string[];
  timeout: number;
  // Loop timing
  pushToFeed: boolean;
  debounceMs: number;
  maxIntervalMs: number;
  cooldownMs: number;
  maxAgeMs: number;
  historyLimit: number;
  /** Grammarly mode: ask the LLM for actionable screen regions each tick */
  regionsEnabled: boolean;
}

/** @deprecated Use AnalysisConfig */
export type AgentConfig = AnalysisConfig;

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
  /** Actual USD cost returned by OpenRouter (undefined if not available). */
  cost?: number;
  /** Actionable screen regions detected this tick (Grammarly mode) */
  regions?: RawRegion[];
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
  /** Pre-fetched knowledge facts from entity subscription cache. */
  knowledgeFacts?: string;
}

// ── Escalation types ──
//
// Transport choice is per-lane now (driven by the overlay's agent selector):
// `escalationAgent === "openclaw"` → WS; any other non-empty agent → HTTP.
// The old global `transport` setting was removed — picking an agent IS the
// transport.

export interface EscalationConfig {
  mode: EscalationMode;
  cooldownMs: number;
  staleMs: number;  // force escalation after this many ms of silence (0 = disabled)
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
  escalation: "active" | "paused";
  connection: "connected" | "disconnected" | "connecting";
  responseSize: ResponseSize;
  /** Bare-agent roster + per-lane current choice. Populated after the
   *  bare agent's POST /bareagent/register. "" lane value = lane disabled. */
  agents: {
    available: string[];
    escalationAgent: string;
    spawnAgent: string;
    registered: boolean;
  };
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

// ── Permission gating for /spawn/approve ──
// Controls which tool-invocations auto-approve (vs. route to overlay for user).
// Tokens are exact tool names (e.g. "Read") or prefix patterns ending with `*`
// (e.g. "mcp__sinain*"). Everything else gets the overlay Allow/Deny prompt.
export interface PermissionsConfig {
  autoApproveTools: string[];
}

// ── Full core config ──

export interface CoreConfig {
  port: number;
  audioConfig: AudioPipelineConfig;
  micConfig: AudioPipelineConfig;
  micEnabled: boolean;
  transcriptionConfig: TranscriptionConfig;
  agentConfig: AnalysisConfig;
  escalationConfig: EscalationConfig;
  openclawConfig: OpenClawConfig;
  situationMdPath: string;
  traceEnabled: boolean;
  costDisplayEnabled: boolean;
  traceDir: string;
  learningConfig: LearningConfig;
  privacyConfig: PrivacyConfig;
  permissionsConfig: PermissionsConfig;
}
