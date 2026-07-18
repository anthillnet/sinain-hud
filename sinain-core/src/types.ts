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

// ── Agent CLI sessions ──

export interface AgentEventFrame {
  session_id: string;
  hook_event_name: string;
  source: string;
  ts?: number;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  message?: string;
  permission_mode?: string;
  prompt?: string;
  model?: string;
  branch?: string;
  term?: Record<string, string>;
}

export interface AgentSession {
  sessionId: string;
  threadId?: string;
  source: string;
  name: string;
  cwd?: string;
  model?: string;
  branch?: string;
  state: "working" | "waiting" | "done";
  toolLine: string;
  startedAt: number;
  lastEventAt: number;
  endedAt?: number;
  summary?: string;
  term?: Record<string, string>;
}

export type ApprovalDecision = { behavior: "allow" | "deny" | "always" | "ask"; answer?: string };

export interface AgentApprovalRequest {
  id: string;
  sessionId: string;
  source: string;
  title: string;
  command: string;
  cwd?: string;
  createdAt: number;
}

export interface AgentSessionsMessage {
  type: "agent_sessions";
  sessions: AgentSession[];
  working: number;
  waiting: number;
}

export interface AgentApprovalMessage {
  type: "agent_approval";
  request: AgentApprovalRequest;
}

export interface AgentApprovalResolvedMessage {
  type: "agent_approval_resolved";
  id: string;
  behavior: "allow" | "deny" | "always" | "ask";
}

export interface AgentApprovalReplyMessage {
  type: "agent_approval_reply";
  id: string;
  behavior: "allow" | "deny" | "always";
  answer?: string;
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

export interface UsageMessage {
  type: "usage";
  fiveHour?: { utilization: number; resetsAt?: number };
  sevenDay?: { utilization: number; resetsAt?: number };
}

/** Entry recorded by CostTracker for each LLM call. */
export interface CostEntry {
  source: "analyzer" | "transcription" | "vision" | "chat" | "burst" | "save";
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

// ── Deliberate capture: window cards (sinain-core → Overlay) ──

/** One row of the situation brief's mini-timeline. */
export interface BriefTimelineEntry {
  /** Relative label, e.g. "−18m". */
  at: string;
  what: string;
}

/** "Call AI on my last N minutes" → situation brief card. */
export interface ContextBriefMessage {
  type: "context_brief";
  /** Correlates the card with the /context/summon request. */
  requestId: string;
  status: "working" | "ready" | "error";
  minutes: number;
  /** Free coverage string, e.g. "IntelliJ · Chrome · mic". */
  coverage: string;
  brief?: {
    timeline: BriefTimelineEntry[];
    goal: string;
    problems: string[];
    entities: string[];
  };
  /** True when the range was truncated (quota/size) — show honest partial. */
  partial?: boolean;
  latencyMs?: number;
  error?: string;
  ts: number;
}

/** "Build context" (clipboard enrich) → context / next card. */
export interface EnrichCardMessage {
  type: "enrich_card";
  requestId: string;
  status: "working" | "ready" | "error";
  /** The focus item (clipboard text), truncated for display. */
  focus: string;
  card?: { context: string };
  latencyMs?: number;
  error?: string;
  ts: number;
}

/** Voice session ("Call sinain") lifecycle. */
export interface VoiceSessionMessage {
  type: "voice_session";
  status: "starting" | "live" | "ended" | "error";
  /** Transport: hidden-webview engine (browser WebRTC stack), local AR
   *  bridge (python aiortc), or the deployed meetbot joining a Google
   *  Meet/Teams call from its container. */
  mode: "webview" | "bridge" | "meet";
  /** Range whose brief seeded the session (0 = unseeded). */
  minutes: number;
  coverage: string;
  /** Human line to surface (e.g. "admit Sinain (AI) from the People panel"). */
  message?: string;
  error?: string;
  ts: number;
}

/** Save-last-N lifecycle: ack → receipt (with undo window) → final. */
export interface SaveReceiptMessage {
  type: "save_receipt";
  saveId: string;
  status: "saving" | "saved" | "committed" | "undone" | "error";
  minutes: number;
  coverage: string;
  facts?: number;
  entities?: number;
  cost?: number;
  /** Seconds remaining in which undo is accepted (present when status=saved). */
  undoSeconds?: number;
  /** Who initiated the save. Absent = "user_save" (deployed-overlay skew). */
  provenance?: SaveProvenance;
  error?: string;
  ts: number;
}

/** KG provenance of a save: manual gesture, an accepted breakpoint offer, or
 *  a wrapped Session Sense session — kept distinguishable forever. */
export type SaveProvenance = "user_save" | "offered_save" | "session_sense";

/** Proactive save offer at a breakpoint (DESIGN-SAVE-OFFER.md): Sinain
 *  proposes a range + scope, the user disposes. Zero-LLM — composed from
 *  window data the buffers already hold. */
export interface SaveOfferMessage {
  type: "save_offer";
  offerId: string;
  /** Proposed range (the episode's engaged span). */
  minutes: number;
  /** Proposed app scope — never includes "mic" (privacy floor). */
  apps: string[];
  /** Display coverage, e.g. "IntelliJ IDEA, Google Chrome". */
  coverage: string;
  threadId: string;
  /** Context line ("mostly: …") — present only when confidently known. */
  threadLabel?: string;
  /** Honest idle tail: trailing minutes of the range with no activity. */
  idleTailMinutes?: number;
  /** Breakpoint timestamp the episode ended at. */
  endedTs: number;
  /** Client-side silent-fade horizon (~45s). */
  expirySeconds: number;
  ts: number;
}

/** Overlay → core response to a save offer (POST /capture/offer/response). */
export type SaveOfferResponse = "accepted" | "adjusted" | "dismissed" | "expired";

// ── Session Sense (DESIGN-SESSION-SENSE.md, wireframes "Session Sense.dc.html") ──

/** How much confidence bought on the nudge card (§2 of the wireframes):
 *  the label is the first thing to go — never hedged. */
export type SessionNudgeGrade = "personal" | "stock" | "unlabeled";

/** Live workflow nudge: "Looks like: applying for a job — track from 11:02?"
 *  Credit-led card (§1): the retroactive-credit sliver is visible before the
 *  tap. Zero-LLM — composed from local embeddings + window data only. */
export interface SessionNudgeMessage {
  type: "session_nudge";
  nudgeId: string;
  grade: SessionNudgeGrade;
  /** Workflow label. Absent when grade="unlabeled" (medium confidence or
   *  category floor) — a statement, never a hedge. */
  label?: string;
  threadId: string;
  /** Retroactive credit start — "11:02 — credited from here". */
  candidateStartTs: number;
  /** "12 min in". */
  elapsedMinutes: number;
  /** Source chips (never "mic" — privacy floor). */
  apps: string[];
  /** "Wrong?" picker rows: the classifier's own next candidates (top-3).
   *  The overlay appends "Just work — no label" itself. */
  alternates: string[];
  /** Help-forward variant A (§8 — explicit product call 2026-07-16, an
   *  amendment of the gesture-gated contract for this one surface): goal +
   *  next steps composed on the burst lane BEFORE consent, over the
   *  already-redacted stream. Absent when the lane is unavailable or slow —
   *  the card degrades to the bare claim, never waits. */
  goal?: string;
  steps?: string[];
  /** Bookmark return (§9): the ⚑ marks the user's own promise, not the
   *  classifier's guess — the card renders "Resume this session?" with ▶. */
  resume?: boolean;
  /** Pre-composed history line for resume nudges, e.g.
   *  "bookmarked yesterday · 2 sessions · 1h 19m so far". */
  resumeMeta?: string;
  /** Client-side silent-fade horizon (~45s). */
  expirySeconds: number;
  ts: number;
}

/** Overlay → core response to a session nudge. `corrected` carries the picked
 *  label ("" = "just work" — shape confirmed, label abstained). */
export type SessionNudgeResponse = "tracked" | "corrected" | "dismissed" | "expired";

/** Running-session chip state (§5): label · elapsed · paused. Broadcast on
 *  every transition; `ended` clears the chip. */
export interface SessionChipMessage {
  type: "session_chip";
  sessionId: string;
  threadId: string;
  status: "running" | "paused" | "ended";
  label: string;
  /** Credited-from timestamp (candidateStartTs). */
  startedTs: number;
  /** Accumulated active (non-paused) milliseconds. */
  activeMs: number;
  agentsWorking?: number;
  ts: number;
}

/** The symmetric "End workout?" prompt (§6): ignorable; a grace period
 *  auto-wraps so a session never runs forever because the user walked away. */
export interface SessionWrapMessage {
  type: "session_wrap";
  sessionId: string;
  label: string;
  activeMinutes: number;
  /** "quiet for 6 min". */
  quietMinutes: number;
  /** "auto-wraps in 10". */
  graceMinutes: number;
  ts: number;
}

/** Overlay → core session actions: wrap now, keep going (corrects a too-eager
 *  decay model), end from the chip (boundary correction), or "⚑ Later" —
 *  wrap + a bookmark on the thread (§9: a flag, not an open session). */
export type SessionAction = "wrapped" | "keep_going" | "ended" | "later" | "flag";

/** Help-forward (§8, variant C): goal + next steps composed ON the track tap
 *  via the burst lane — consent already given, zero contract spent. */
export interface SessionAssistMessage {
  type: "session_assist";
  sessionId: string;
  status: "working" | "ready" | "error";
  goal?: string;
  steps?: string[];
  error?: string;
  ts: number;
}

/** A bookmarked thread (§9): the persisted promise. Meta is cumulative —
 *  sessions so far · total time · last touched. */
export interface SessionBookmarkRow {
  threadId: string;
  label: string;
  sessions: number;
  totalMs: number;
  lastTs: number;
  /** Wiki path for ↗ share — resolved against the KG when an entity matches
   *  (e.g. "/knowledge/ui/entity/oxigraph-migration"); the existing share
   *  mechanic (opt-out entity list, share links) lives on that page. */
  kgPath?: string;
}

export type OutboundMessage = FeedMessage | StatusMessage | PingMessage | ThreadStatusMessage | CostMessage | UsageMessage | RegionHighlightMessage | ContextBriefMessage | EnrichCardMessage | SaveReceiptMessage | SaveOfferMessage | SessionNudgeMessage | SessionChipMessage | SessionWrapMessage | SessionAssistMessage | VoiceSessionMessage | AgentSessionsMessage | AgentApprovalMessage | AgentApprovalResolvedMessage;
export type InboundMessage = UserMessage | CommandMessage | PongMessage | ProfilingMessage | UserCommandMessage | SpawnCommandMessage | SpawnReplyMessage | SpawnPermissionReplyMessage | ForkMainMessage | RegionSelectMessage | AppFocusMessage | AgentApprovalReplyMessage;

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
/** Fast-inference lane for deliberate-capture gestures (summon/enrich).
 *  Cerebras by default (OpenAI-compatible); any compatible endpoint works. */
export interface BurstConfig {
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

/** Breakpoint save offers (DESIGN-SAVE-OFFER.md): thresholds + caps for the
 *  proactive "Save these N min?" nudge. Caps are the doc's binding guardrails;
 *  thresholds are tuned, not designed. */
export interface SaveOfferConfig {
  enabled: boolean;
  /** Minimum engaged minutes for an episode to qualify ("long"). */
  minMinutes: number;
  /** ≤ N offers per day. */
  maxPerDay: number;
  /** ≥ N minutes between offers. */
  cooldownMinutes: number;
  /** Client-side silent-fade horizon for an untouched offer. */
  expirySeconds: number;
}

/** Session Sense (DESIGN-SESSION-SENSE.md): live workflow detection — the
 *  Watch's workout nudge for knowledge work. Detection is local and LLM-free;
 *  the tap is the gesture. Caps are shared with the save offer (one attention
 *  budget); thresholds are tuned, not designed. */
export interface SessionSenseConfig {
  /** Default false — an autonomous lane, opt-in by convention. */
  enabled: boolean;
  /** Engaged minutes before a live episode qualifies for the nudge — the
   *  same "long" notion as the save offer, surfaced mid-episode. */
  qualifyMinutes: number;
  /** How long an IGNORED (expired) nudge snoozes its thread — "not now",
   *  not "no"; an explicit ✕ silences for the day instead. */
  snoozeMinutes: number;
  /** Attention away from the session's apps this long → paused. */
  pauseGraceSeconds: number;
  /** Paused this long → the wrap prompt (§6 "quiet for N min"). */
  endQuietMinutes: number;
  /** Wrap prompt ignored this long → auto-wrap (same receipt). */
  wrapGraceMinutes: number;
  /** Client-side silent-fade horizon for an untouched nudge. */
  expirySeconds: number;
  /** Hard ceiling on the credited span (matches the chooser's ceiling). */
  maxSessionMinutes: number;
}

/** "Call sinain" voice sessions via the ARSinain bridge (tools/ar-bridge). */
export interface VoiceConfig {
  enabled: boolean;
  /** ARSinain base URL (aiortc signaling) for the local bridge transport. */
  serverUrl: string;
  /** X-Auth-Request-Email for entitlement-gated servers ("" locally). */
  email: string;
  /** sck-capture frame IPC file the bridge publishes as the video track. */
  framePath: string;
  /** Screen publish rate. */
  fps: number;
  /** Media engine: "webview" = hidden WKWebView in the overlay running the
   *  browser WebRTC stack (real AEC/NS/AGC + adaptive jitter buffer —
   *  call-quality parity with the web client); "bridge" = python aiortc
   *  fallback (raw mic, no echo cancellation). */
  engine: "webview" | "bridge";
  /** TURN credential minter the call page fetches ICE servers from. */
  turnUrl: string;
  /** Deployed ARSinain for the meetbot transport (POST /meet). */
  meetServerUrl: string;
  /** oauth2-proxy session cookie for the deployed server ("your account").
   *  Copy the `_oauth2_proxy` cookie from a logged-in browser session. */
  meetCookie: string;
}

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
  /** Cloud fallback (OpenRouter) for when the local Ollama model is absent, so
   *  the fast region lane keeps working in cloud mode with NO local models.
   *  Empty cloudApiKey ⇒ no fallback (lane disables on a missing local model). */
  cloudModel: string;
  cloudEndpoint: string;
  cloudApiKey: string;
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
  agentApproveTimeoutMs: number;
  agentEnrichEnabled: boolean;
  /** Boot default / environment kill switch for the optional agent-start LLM brief. */
  agentLlmBriefEnabled: boolean;
  claudeUsageEnabled: boolean;
  claudeUsagePollMs: number;
  regionSlmConfig: RegionSlmConfig;
  burstConfig: BurstConfig;
  saveOfferConfig: SaveOfferConfig;
  sessionSenseConfig: SessionSenseConfig;
  voiceConfig: VoiceConfig;
  /** Rolling-window retention horizon for feed/sense buffers (ms). */
  windowHorizonMs: number;
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
