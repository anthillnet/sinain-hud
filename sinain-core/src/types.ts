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
  /** Message origin shown in the overlay ("user" | "spawn" | agent default) */
  sender?: string;
  /** Region thread this message belongs to — the overlay routes it to that
   *  region's tab instead of the main feed (Grammarly mode). */
  regionId?: string;
}

/** sinain-core → Overlay: status update */
export interface StatusMessage {
  type: "status";
  audio: string;
  mic: string;
  screen: string;
  escalation?: string;
  /** "on" | "off" — ambient/idle messages toggle (opt-in, default off). */
  idleMessages?: string;
  connection: string;
  responseSize?: string;
  /** Bare-agent roster + per-lane current choice. Omitted until the bare
   *  agent has registered via POST /bareagent/register. empty-string lane
   *  values mean "Off" (lane disabled). */
  agents?: {
    available: string[];
    /** Terminal-lane roster — `available` minus sinain-typed (no-TUI) profiles. */
    terminalAvailable?: string[];
    escalationAgent: string;
    /** Interactive terminal lane; decoupled from escalation, excludes sinain. */
    terminalAgent?: string;
    /** True when the chat lane is a resident sidecar (type "sinain"): its
     *  liveness is the sidecar WS, NOT bare-agent registration, so the overlay
     *  must not demand a terminal/start for it. */
    escalationResident?: boolean;
    /** True when the chat lane is a desktop app (Claude Desktop / ChatGPT):
     *  chat opens the external app, so the overlay must NOT open its own HUD
     *  chat surface for it. */
    escalationDesktop?: boolean;
    /** True when the resident chat sidecar (:9610) is reachable. With a resident
     *  lane, "down" → overlay shows "Chat sidecar not running" + Run-to-restart. */
    chatSidecarUp?: boolean;
    registered: boolean;
  };
}

/** sinain-core → Overlay: heartbeat ping */
export interface PingMessage {
  type: "ping";
  ts: number;
}

/** sinain-core → Overlay: spawn task lifecycle update */
export type ThreadStatus = "spawned" | "polling" | "completed" | "failed" | "timeout" | "awaiting_input" | "awaiting_permission";

export interface ThreadStatusMessage {
  /** Wire literal stays "spawn_task" — deployed overlays parse it; the
   *  overlay and core update independently, so renaming it would break
   *  skewed pairs. Internal names say what it is: thread status. */
  type: "spawn_task";
  taskId: string;
  label: string;
  status: ThreadStatus;
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
  /** Line-id path (region-detector): the detector picked a specific OCR LINE,
   *  so the anchor is already resolved — `issue` is a clean description (not a
   *  quote) and these carry the exact geometry. When present, the tracker uses
   *  them directly and derives the stable id from `anchorText` (the verbatim
   *  line) so re-phrased descriptions don't spawn duplicate eyes. */
  bbox?: [number, number, number, number];
  frameSize?: [number, number];
  anchorText?: string;
  sourceOcr?: string;
  app?: string;
  display?: number;
  /** Two-tier cascade: the SLM lane emits provisional eyes (instant, templated
   *  placeholder label); the main analyzer lane emits quality (non-provisional)
   *  regions that UPGRADE them in place. Unratified provisionals expire. */
  provisional?: boolean;
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
  /** Verbatim OCR line the eye is anchored to (the line refineToLine matched).
   *  Re-anchoring tracks THIS across frames, not the (often paraphrased) issue
   *  text — so the eye follows its content on scroll/typing. */
  anchorText?: string;
  /** App the region was detected in */
  app?: string;
  /** Display id (CGDirectDisplayID) the region was detected on — lets the
   *  overlay place the eye on the right screen (multi-display). 0/undefined
   *  → main display. */
  display?: number;
  /** User-selected region (drag-select) — pinned while its app is frontmost,
   *  exempt from the analyzer's admission cap and re-emission expiry. */
  manual?: boolean;
  /** Optimistically restored from the archive on app re-entry, awaiting the
   *  next analyzer tick to confirm it's still valid. Overlay dims it. */
  pending?: boolean;
  /** SLM-prepopulated, awaiting a quality description from the main lane. The
   *  label is a templated placeholder ("Thinking about this email…"); the
   *  overlay dims it. Cleared when the analyzer upgrades it. */
  provisional?: boolean;
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

/** Overlay → sinain-core: fork MAIN into a new thread */
export interface ForkMainMessage {
  type: "fork_main";
}

/** Overlay → sinain-core: user drag-selected a screen region (manual ROI).
 *  Rect in screen points, top-left origin. */
export interface RegionSelectMessage {
  type: "region_select";
  x: number;
  y: number;
  w: number;
  h: number;
  screenW: number;
  screenH: number;
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

/** Overlay → sinain-core: frontmost application changed. A fast OS-level
 *  signal (NSWorkspace) that lands ahead of the sense pipeline — drives the
 *  instant ROI restore on app switch. `app` is the localizedName (matched
 *  case-insensitively against sense's process-name namespace). */
export interface AppFocusMessage {
  type: "app_focus";
  app: string;
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
  source: "analyzer" | "transcription" | "vision" | "chat";
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
  /** Token throughput — accumulated even when cost is 0 (local models), so the
   *  /cost endpoint stays useful in local mode and shows chat token volume. */
  totalTokensIn: number;
  totalTokensOut: number;
  tokensInBySource: Record<string, number>;
  tokensOutBySource: Record<string, number>;
}

export type OutboundMessage = FeedMessage | StatusMessage | PingMessage | ThreadStatusMessage | CostMessage | RegionHighlightMessage;
export type InboundMessage = UserMessage | CommandMessage | PongMessage | ProfilingMessage | UserCommandMessage | SpawnCommandMessage | SpawnReplyMessage | SpawnPermissionReplyMessage | ForkMainMessage | RegionSelectMessage | AppFocusMessage;

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
  /** Per-line OCR boxes in full-frame pixels (top-left origin) — lets the
   *  region tracker anchor an eye at the exact line of an issue instead of
   *  the whole change-region. */
  ocrLines?: { text: string; bbox: [number, number, number, number] }[];
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
  /**
   * Optional hotword/entity hint string passed into the transcription
   * prompt. Modeled after Whisper's --prompt flag and AWS Transcribe /
   * Deepgram / AssemblyAI custom-vocabulary APIs: biases the model toward
   * preserving these proper nouns rather than substituting phonetic
   * neighbors. Set via TRANSCRIPTION_INITIAL_PROMPT env var; can be a
   * comma-separated list of names ("Mustafa, Citibank, JetBrains, Tariq").
   */
  initialPrompt?: string;
  /** Local whisper-cpp settings (only used when backend=local) */
  local: {
    bin: string;
    modelPath: string;
    language: string;
    timeoutMs: number;
    initialPrompt?: string;
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
  /** Whether the agent analyzer runs vision itself. When false (local mode
   *  default), sense_client owns the single vision pass and the agent stays
   *  text-only. Undefined ⇒ treated as true (preserves cloud behavior). */
  agentVision?: boolean;
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

/**
 * Tier-0 local-SLM region lane (experiment). When enabled, a small local model
 * (Ollama) detects actionable screen regions on its own fast cadence — decoupled
 * from the cloud analyzer's hud/digest call and its debounce — so eyes appear at
 * near-frame rate with no network. The cloud loop keeps writing hud/digest but
 * yields region detection to this lane while it's on (clean A/B).
 */
export interface RegionSlmConfig {
  /** Master switch for the local-SLM region detector (default false). */
  enabled: boolean;
  /** Ollama model tag, e.g. "phi4-mini", "qwen2.5:7b", "gemma4:e2b". */
  model: string;
  /** Ollama base URL (default http://localhost:11434). */
  endpoint: string;
  /** Coalescing window after a screen change before detecting (default 500ms). */
  debounceMs: number;
  /** Cap on generated tokens — regions JSON is small (default 256). */
  maxTokens: number;
  /** Per-call timeout; aborts a slow/superseded generation (default 6000ms). */
  timeoutMs: number;
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
  /** Ambient/idle (unsolicited) HUD messages. Opt-in, default "off",
   *  decoupled from `escalation` so selecting a chat agent never flips it on. */
  idleMessages: "on" | "off";
  connection: "connected" | "disconnected" | "connecting";
  responseSize: ResponseSize;
  /** Bare-agent roster + per-lane current choice. Populated after the
   *  bare agent's POST /bareagent/register. "" lane value = lane disabled. */
  agents: {
    available: string[];
    /** Terminal-lane roster — `available` minus sinain-typed (no-TUI) profiles. */
    terminalAvailable?: string[];
    escalationAgent: string;
    /** Interactive terminal lane; decoupled from escalation, excludes sinain. */
    terminalAgent?: string;
    /** True when the chat lane is a resident sidecar (type "sinain"). */
    escalationResident?: boolean;
    /** True when the chat lane is a desktop app (Claude Desktop / ChatGPT). */
    escalationDesktop?: boolean;
    /** True when the resident chat sidecar (:9610) is reachable. */
    chatSidecarUp?: boolean;
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
  /** Network interface to bind. Defaults to 127.0.0.1 (loopback only).
   *  Set SINAIN_BIND_HOST=0.0.0.0 to expose on the LAN (opt-in). */
  host: string;
  audioConfig: AudioPipelineConfig;
  micConfig: AudioPipelineConfig;
  micEnabled: boolean;
  transcriptionConfig: TranscriptionConfig;
  agentConfig: AnalysisConfig;
  regionSlmConfig: RegionSlmConfig;
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
