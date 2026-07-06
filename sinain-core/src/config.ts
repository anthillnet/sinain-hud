import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { CoreConfig, AudioPipelineConfig, TranscriptionConfig, AnalysisConfig, EscalationConfig, OpenClawConfig, EscalationMode, LearningConfig, PrivacyConfig, PrivacyMatrix, PrivacyLevel, PrivacyRow } from "./types.js";
import { PRESETS } from "./privacy/presets.js";
import { loadAgentsConfig, findGatewayProfile, type AgentsConfig } from "./agents-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The .env file path that was actually loaded (if any). */
export let loadedEnvPath: string | undefined;

function loadDotEnv(): void {
  // Try sinain-core/.env first, then project root .env, then the wizard's
  // ~/.sinain/.env. The npx launcher normally injects ~/.sinain/.env via the
  // process environment, but direct runs (node dist/index.js, npm run dev)
  // bypass the launcher — without this fallback they silently miss
  // OPENROUTER_API_KEY etc. (agents.json is already read from ~/.sinain).
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    resolve(__dirname, "..", ".env"),
    resolve(__dirname, "..", "..", ".env"),
    ...(home ? [resolve(home, ".sinain", ".env")] : []),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const raw = readFileSync(envPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        } else {
          // Strip inline comments (# preceded by whitespace) for unquoted values
          const ci = val.search(/\s+#/);
          if (ci !== -1) val = val.slice(0, ci).trimEnd();
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
      loadedEnvPath = envPath;
      console.log(`[config] loaded ${envPath}`);
      return;
    } catch { /* ignore */ }
  }
}

loadDotEnv();

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function floatEnv(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true";
}

/** Like env() but treats a defined-but-empty value as "" instead of falling through to fallback. */
function envAllowEmpty(key: string, fallbackKey?: string, defaultVal = ""): string {
  if (process.env[key] !== undefined) return process.env[key]!;
  if (fallbackKey && process.env[fallbackKey] !== undefined) return process.env[fallbackKey]!;
  return defaultVal;
}

function resolvePath(p: string): string {
  if (process.platform === "win32") {
    // Expand %APPDATA%, %USERPROFILE%, %TEMP% etc.
    p = p.replace(/%([^%]+)%/g, (_, key) => process.env[key] || "");
  }
  return p.replace(/^~/, os.homedir());
}

/** Return platform-appropriate default data directory. */
function sinainDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || resolve(os.homedir(), "AppData", "Roaming");
    return resolve(appData, "sinain");
  }
  return resolve(os.homedir(), ".sinain-core");
}

function sinainCaptureDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || resolve(os.homedir(), "AppData", "Roaming");
    return resolve(appData, "sinain", "capture");
  }
  return resolve(os.homedir(), ".sinain", "capture");
}


function loadPrivacyConfig(): PrivacyConfig {
  const mode = env("PRIVACY_MODE", "off");

  // Start with preset (default to "off" which is ALL_FULL)
  const baseMatrix: PrivacyMatrix = PRESETS[mode] ? { ...PRESETS[mode] } : { ...PRESETS["off"] };

  // Data type env var name → matrix key
  const DATA_TYPE_MAP: Record<string, keyof PrivacyMatrix> = {
    AUDIO: "audio_transcript",
    OCR: "screen_ocr",
    IMAGES: "screen_images",
    TITLES: "window_titles",
    CREDENTIALS: "credentials",
    METADATA: "metadata",
  };

  // Destination env var name → row key
  const DEST_MAP: Record<string, keyof PrivacyRow> = {
    LOCAL_BUFFER: "local_buffer",
    LOCAL_LLM: "local_llm",
    TRIPLE_STORE: "triple_store",
    OPENROUTER: "openrouter",
    AGENT_GATEWAY: "agent_gateway",
  };

  // Allow per-cell overrides: PRIVACY_<DATA>_<DEST>=<level>
  for (const [dtKey, dtField] of Object.entries(DATA_TYPE_MAP)) {
    for (const [destKey, destField] of Object.entries(DEST_MAP)) {
      const envKey = `PRIVACY_${dtKey}_${destKey}`;
      const val = process.env[envKey];
      if (val && ["full", "redacted", "summary", "none"].includes(val)) {
        baseMatrix[dtField][destField] = val as PrivacyLevel;
      }
    }
  }

  return { mode, matrix: baseMatrix };
}

export function loadConfig(): CoreConfig {
  // sinain-agent-runner/agents.json is the new single source of truth for the
  // bare-agent + OpenClaw config that used to live in .env. Loading
  // happens once at startup; null means the file isn't there (fresh
  // checkout, custom layout, etc.) and we fall back to env defaults.
  const agentsCfg = loadAgentsConfig();
  if (agentsCfg) {
    console.log(`[config] loaded agents config from ${agentsCfg.loadedFrom}`);
  }

  // Helpers that prefer agents.json values, then env, then a hardcoded
  // default. Keeps .env working as a safety net during the migration.
  const fromCfgStr = (cfgVal: string | undefined, envKey: string, def: string): string => {
    if (cfgVal !== undefined && cfgVal !== "") return cfgVal;
    return env(envKey, def);
  };
  const fromCfgInt = (cfgVal: number | undefined, envKey: string, def: number): number => {
    if (cfgVal !== undefined) return cfgVal;
    return intEnv(envKey, def);
  };

  const audioConfig: AudioPipelineConfig = {
    device: env("AUDIO_DEVICE", "BlackHole 2ch"),
    sampleRate: intEnv("AUDIO_SAMPLE_RATE", 16000),
    channels: 1,
    chunkDurationMs: intEnv("AUDIO_CHUNK_MS", 5000),
    vadEnabled: boolEnv("AUDIO_VAD_ENABLED", true),
    vadThreshold: floatEnv("AUDIO_VAD_THRESHOLD", 0.001),
    captureCommand: env("AUDIO_CAPTURE_CMD", "screencapturekit") as "sox" | "ffmpeg" | "screencapturekit",
    autoStart: boolEnv("AUDIO_AUTO_START", true),
    gainDb: intEnv("AUDIO_GAIN_DB", 20),
  };

  const micEnabled = boolEnv("MIC_ENABLED", false);
  const micConfig: AudioPipelineConfig = {
    device: env("MIC_DEVICE", "default"),
    sampleRate: intEnv("MIC_SAMPLE_RATE", 16000),
    channels: 1,
    chunkDurationMs: intEnv("MIC_CHUNK_MS", 5000),
    vadEnabled: boolEnv("MIC_VAD_ENABLED", true),
    vadThreshold: floatEnv("MIC_VAD_THRESHOLD", 0.008),
    captureCommand: env("MIC_CAPTURE_CMD", "sox") as "sox" | "ffmpeg" | "screencapturekit",
    autoStart: boolEnv("MIC_AUTO_START", false),
    gainDb: intEnv("MIC_GAIN_DB", 0),
  };

  // ── Local mode: unified config ──────────────────────────────────────────
  // SINAIN_LOCAL_MODE=true auto-derives all component config from two vars:
  //   SINAIN_LOCAL_LLM=phi4-mini       → analyzer + distiller
  //   SINAIN_LOCAL_VISION=qwen2.5vl:7b → sense_client (propagated via start.sh)
  // Must run BEFORE transcriptionConfig / analysisConfig are read.
  const localMode = boolEnv("SINAIN_LOCAL_MODE", false);
  if (localMode) {
    const localLlm = env("SINAIN_LOCAL_LLM", "qwen2.5:3b");
    const localVision = env("SINAIN_LOCAL_VISION", "qwen2.5vl:7b");
    if (!process.env.ANALYSIS_PROVIDER) process.env.ANALYSIS_PROVIDER = "ollama";
    if (!process.env.ANALYSIS_MODEL) process.env.ANALYSIS_MODEL = localLlm;
    // ANALYSIS_VISION_MODEL must point at a VISION-capable model (qwen2.5vl,
    // gemma4 vision variants, llava). Previously misconfigured to localLlm
    // (text-only phi4-mini), which made the analyzer's image-tick path fail
    // silently in local-mode.
    if (!process.env.ANALYSIS_VISION_MODEL) process.env.ANALYSIS_VISION_MODEL = localVision;
    if (!process.env.TRANSCRIPTION_BACKEND) process.env.TRANSCRIPTION_BACKEND = "local";
    if (!process.env.LOCAL_VISION_ENABLED) process.env.LOCAL_VISION_ENABLED = "true";
    if (!process.env.LOCAL_VISION_MODEL) process.env.LOCAL_VISION_MODEL = localVision;
    if (!process.env.SINAIN_FAST_MODEL) process.env.SINAIN_FAST_MODEL = `ollama/${localLlm}`;
    if (!process.env.SINAIN_SMART_MODEL) process.env.SINAIN_SMART_MODEL = `ollama/${localLlm}`;
  }

  const transcriptionInitialPrompt = env("TRANSCRIPTION_INITIAL_PROMPT", "");
  const whisperModelPath = resolvePath(env("LOCAL_WHISPER_MODEL", "~/.sinain/models/whisper/ggml-large-v3-turbo.bin"));
  const transcriptionApiKey = env("OPENROUTER_API_KEY", "");
  // Local-first by default: audio stays on-device (privacy) and whisper quality
  // beats the cloud LLM path (see eval). But the ~1.5GB model downloads in the
  // background on first launch — until it's present we fall back to cloud (when
  // a key exists) rather than silently producing nothing. The model-presence
  // gate also keeps a bare `npm run dev` (no provisioning) safe: no model →
  // cloud, no surprise download. A restart picks up local once the model lands.
  let transcriptionBackend = env("TRANSCRIPTION_BACKEND", "local") as TranscriptionConfig["backend"];
  if (transcriptionBackend === "local" && !existsSync(whisperModelPath)) {
    if (transcriptionApiKey) {
      console.warn(`[config] whisper model not present yet (${whisperModelPath}) — using cloud transcription until it finishes downloading (restart to switch to local)`);
      transcriptionBackend = "openrouter";
    } else {
      console.warn(`[config] whisper model not present (${whisperModelPath}) and no OPENROUTER_API_KEY — transcription unavailable until the model downloads`);
    }
  }
  const transcriptionConfig: TranscriptionConfig = {
    backend: transcriptionBackend,
    openrouterApiKey: transcriptionApiKey,
    geminiModel: env("TRANSCRIPTION_MODEL", "google/gemini-2.5-flash"),
    language: env("TRANSCRIPTION_LANGUAGE", "auto"),
    initialPrompt: transcriptionInitialPrompt || undefined,
    local: {
      bin: env("LOCAL_WHISPER_BIN", "whisper-cli"),
      modelPath: whisperModelPath,
      language: env("TRANSCRIPTION_LANGUAGE", "auto"),
      timeoutMs: intEnv("LOCAL_WHISPER_TIMEOUT_MS", 15000),
      initialPrompt: transcriptionInitialPrompt || undefined,
    },
  };

  const analysisProvider = env("ANALYSIS_PROVIDER", "openrouter") as import("./types.js").AnalysisProvider;
  const defaultEndpoint = analysisProvider === "ollama"
    ? "http://localhost:11434"
    : "https://openrouter.ai/api/v1/chat/completions";

  const agentConfig: import("./types.js").AnalysisConfig = {
    enabled: boolEnv("AGENT_ENABLED", true),
    provider: analysisProvider,
    model: env("ANALYSIS_MODEL", "google/gemini-2.5-flash-lite"),
    visionModel: env("ANALYSIS_VISION_MODEL", "google/gemini-2.5-flash"),
    // Whether the AGENT analyzer itself does vision. In local mode it defaults
    // OFF — sense_client owns the single on-device vision pass (qwen2.5vl) and
    // the agent reasons over OCR + sense's scene caption on the fast text model,
    // so the heavy vision model isn't run twice on the same GPU. Cloud defaults
    // ON (cloud vision is cheap + parallel). Override with SINAIN_AGENT_VISION.
    agentVision: boolEnv("SINAIN_AGENT_VISION", !localMode),
    endpoint: env("ANALYSIS_ENDPOINT", defaultEndpoint),
    apiKey: env("ANALYSIS_API_KEY", env("OPENROUTER_API_KEY", "")),
    maxTokens: intEnv("ANALYSIS_MAX_TOKENS", 800),
    temperature: floatEnv("ANALYSIS_TEMPERATURE", 0.3),
    fallbackModels: env("ANALYSIS_FALLBACK_MODELS", "google/gemini-2.5-flash,anthropic/claude-3.5-haiku")
      .split(",").map(s => s.trim()).filter(Boolean),
    timeout: intEnv("ANALYSIS_TIMEOUT", 15000),
    pushToFeed: boolEnv("AGENT_PUSH_TO_FEED", true),
    // analyzer pacing: agents.json `analyzer` block, fall back to env
    debounceMs: fromCfgInt(agentsCfg?.analyzer?.debounceMs, "AGENT_DEBOUNCE_MS", 3000),
    maxIntervalMs: fromCfgInt(agentsCfg?.analyzer?.maxIntervalMs, "AGENT_MAX_INTERVAL_MS", 30000),
    cooldownMs: intEnv("AGENT_COOLDOWN_MS", 10000),
    maxAgeMs: intEnv("AGENT_MAX_AGE_MS", 120000),
    historyLimit: intEnv("AGENT_HISTORY_LIMIT", 50),
    // Auto-detect issues (Grammarly mode region eyes). Boot default only —
    // the overlay's "AUTO-DETECT ISSUES" toggle is authoritative at runtime.
    regionsEnabled: boolEnv("AUTO_DETECT_ISSUES", false),
  };

  // Tier-0 local-SLM region lane (experiment). Off by default; flip
  // REGION_SLM_ENABLED=true to let a small local Ollama model own ROI detection
  // on a fast cadence instead of the cloud analyzer.
  const regionSlmConfig: import("./types.js").RegionSlmConfig = {
    // On by default in EVERY mode — it only actually runs when region-eyes are
    // enabled (AUTO_DETECT_ISSUES), and degrades gracefully if Ollama/model is
    // absent (eyes still come from the main analyzer lane). Set false to disable.
    enabled: boolEnv("REGION_SLM_ENABLED", true),
    // Small, DEDICATED model — never the local-mode main model (qwen2.5:7b),
    // which Ollama serializes, queueing detection behind the analyzer/distiller.
    // 3b (≈2GB, ~0.5-1s) writes clean descriptions; the line-id prompt means it
    // only has to pick a line + describe (not quote), so it doesn't need to be
    // large. 1.5b is a faster/lower-quality fallback.
    model: env("REGION_SLM_MODEL", "qwen2.5:3b"),
    endpoint: env("REGION_SLM_ENDPOINT", "http://localhost:11434"),
    debounceMs: intEnv("REGION_SLM_DEBOUNCE_MS", 500),
    maxTokens: intEnv("REGION_SLM_MAX_TOKENS", 256),
    timeoutMs: intEnv("REGION_SLM_TIMEOUT_MS", 6000),
    // Cloud fallback: a cheap/fast model runs the SAME focused region prompt when
    // local Ollama is absent — keeps tier-0 eyes working for no-Ollama cloud users.
    cloudModel: env("REGION_SLM_CLOUD_MODEL", "google/gemini-2.5-flash-lite"),
    cloudEndpoint: env("REGION_SLM_CLOUD_ENDPOINT", "https://openrouter.ai/api/v1/chat/completions"),
    cloudApiKey: env("ANALYSIS_API_KEY", env("OPENROUTER_API_KEY", "")),
  };

  // Deliberate-capture burst lane: fast inference for summon ("Call AI on my
  // last N minutes") and enrich ("Build context"). Cerebras by default —
  // measured ~25K tok/s prefill, so a 30-min window brief lands in ~1.5s.
  // Falls back to disabled (endpoints return 503) when no API key is present.
  const burstConfig: import("./types.js").BurstConfig = {
    enabled: boolEnv("BURST_ENABLED", true),
    provider: env("BURST_PROVIDER", "cerebras"),
    model: env("BURST_MODEL", "gemma-4-31b"),
    endpoint: env("BURST_ENDPOINT", "https://api.cerebras.ai/v1/chat/completions"),
    apiKey: env("BURST_API_KEY", env("CEREBRAS_API_KEY", "")),
    maxTokens: intEnv("BURST_MAX_TOKENS", 700),
    timeoutMs: intEnv("BURST_TIMEOUT_MS", 20000),
  };

  // "Talk to Sinain" voice sessions — the ar-bridge publishes screen + mic to
  // an ARSinain server over WebRTC, seeded with a window brief. Local dev
  // default: ARSinain on 127.0.0.1:8089 (its AR_HELP_PORT default).
  const voiceConfig: import("./types.js").VoiceConfig = {
    enabled: boolEnv("VOICE_ENABLED", true),
    serverUrl: env("ARSINAIN_URL", "http://127.0.0.1:8089"),
    email: env("ARSINAIN_EMAIL", ""),
    framePath: resolvePath(env("VOICE_FRAME_PATH", resolve(os.homedir(), ".sinain", "capture", "frame.jpg"))),
    fps: floatEnv("VOICE_FPS", 4),
  };

  // escalation policy: agents.json `escalation` block, fall back to env.
  // Mode is runtime-mutable via the overlay's flash-icon selector; this only
  // sets the boot-time default. (Transport is no longer a setting — per-lane
  // agent choice in the overlay determines WS vs HTTP dispatch.)
  const escalationMode = fromCfgStr(agentsCfg?.escalation?.mode, "ESCALATION_MODE", "rich") as EscalationMode;
  const escalationConfig: EscalationConfig = {
    mode: escalationMode,
    cooldownMs: fromCfgInt(agentsCfg?.escalation?.cooldownMs, "ESCALATION_COOLDOWN_MS", 30000),
    // Idle messages OFF by default (0): the stale override force-escalates a
    // proactive chat turn after prolonged silence — each re-sends a large
    // uncached context and is the dominant token cost. Reactive escalation
    // (the normal proactive thread chat) is unaffected. Opt in by setting
    // ESCALATION_STALE_MS > 0 (e.g. 90000); see the startup token-cost warning.
    staleMs: fromCfgInt(agentsCfg?.escalation?.staleMs, "ESCALATION_STALE_MS", 0),
  };

  // OpenClaw gateway config: pick the first openclaw-TYPED profile
  // (preferring the canonical name "openclaw"). This lets users add
  // server-side variants — `nemoclaw`, `nanoclaw-prod`, etc. — as full
  // peers; the WS client connects to whichever shows up first in the
  // profiles list. Removing all openclaw-typed profiles (and unsetting
  // the env vars) leaves gatewayWsUrl empty → registerBareAgent skips
  // injecting any gateway entry into the roster, and escalator.start()
  // skips the WS connect.
  //
  // Limitation: only ONE gateway URL gets a live WS client today. Adding
  // multiple openclaw-typed profiles with different URLs lets the user
  // pick them in the overlay roster, but dispatch always uses the first
  // one's connection params. True per-profile WS clients is a follow-up.
  const gateway = findGatewayProfile(agentsCfg);
  const openclawProfile = gateway?.profile;
  // wsUrl/hookUrl default to empty so "delete the openclaw profile" genuinely
  // disables the gateway. The shipped agents.example.json includes the
  // profile with localhost defaults, so fresh installs still work out of
  // the box; removal is an explicit opt-out.
  const openclawConfig: OpenClawConfig = {
    gatewayWsUrl: fromCfgStr(openclawProfile?.wsUrl, "OPENCLAW_WS_URL",
      envAllowEmpty("OPENCLAW_GATEWAY_WS_URL", undefined, "")),
    gatewayToken: fromCfgStr(openclawProfile?.wsToken, "OPENCLAW_WS_TOKEN",
      env("OPENCLAW_GATEWAY_TOKEN", "")),
    hookUrl: fromCfgStr(openclawProfile?.httpUrl, "OPENCLAW_HTTP_URL",
      envAllowEmpty("OPENCLAW_HOOK_URL", undefined, "")),
    hookToken: fromCfgStr(openclawProfile?.httpToken, "OPENCLAW_HTTP_TOKEN",
      env("OPENCLAW_HOOK_TOKEN", "")),
    sessionKey: fromCfgStr(openclawProfile?.sessionKey, "OPENCLAW_SESSION_KEY", "agent:main:sinain"),
    phase1TimeoutMs: fromCfgInt(openclawProfile?.phase1TimeoutMs, "OPENCLAW_PHASE1_TIMEOUT_MS", 30_000),
    phase2TimeoutMs: fromCfgInt(openclawProfile?.phase2TimeoutMs, "OPENCLAW_PHASE2_TIMEOUT_MS", 120_000),
    pingIntervalMs: fromCfgInt(openclawProfile?.pingIntervalMs, "OPENCLAW_PING_INTERVAL_MS", 30_000),
  };

  const situationDir = env("OPENCLAW_WORKSPACE_DIR", "~/.openclaw/workspace");
  const situationMdPath = resolvePath(
    env("SITUATION_MD_PATH", `${situationDir}/SITUATION.md`)
  );

  const defaultFeedbackDir = resolve(sinainDataDir(), "feedback");
  const learningConfig: LearningConfig = {
    enabled: boolEnv("LEARNING_ENABLED", true),
    feedbackDir: resolvePath(env("FEEDBACK_DIR", defaultFeedbackDir)),
    retentionDays: intEnv("FEEDBACK_RETENTION_DAYS", 30),
  };

  const privacyConfig = loadPrivacyConfig();

  // autoApproveTools: agents.json top-level field, falls back to
  // SINAIN_AUTO_APPROVE_TOOLS env. Space-separated tool names or prefix
  // patterns (suffix *) that sinain-core auto-approves at /spawn/approve
  // without routing to the overlay.
  const autoApproveRaw = fromCfgStr(
    agentsCfg?.autoApproveTools,
    "SINAIN_AUTO_APPROVE_TOOLS",
    // Default auto-approve covers the Claude Code core tools the escalation
    // flow realistically uses without prompting. Bash is intentionally NOT
    // included — users wanting scoped shell commands without prompts should
    // add patterns like "Bash(git:*) Bash(npm:*)" to agents.json.
    "Read Glob Grep Ls Cat Edit Write MultiEdit NotebookEdit " +
    "WebFetch WebSearch " +
    "TaskCreate TaskUpdate TaskGet TaskList TaskOutput TaskStop " +
    "LSP Skill Monitor BashOutput KillBash " +
    "mcp__sinain* ToolSearch",
  );
  const permissionsConfig = {
    autoApproveTools: autoApproveRaw.split(/\s+/).filter((t) => t.length > 0),
  };

  return {
    port: intEnv("PORT", 9500),
    // Loopback-only by default; SINAIN_BIND_HOST=0.0.0.0 opts into LAN exposure.
    host: env("SINAIN_BIND_HOST", "127.0.0.1"),
    audioConfig,
    micConfig,
    micEnabled,
    transcriptionConfig,
    agentConfig,
    regionSlmConfig,
    burstConfig,
    voiceConfig,
    // Rolling window retention (deliberate capture): how far back "save/summon
    // last N minutes" can reach. Default 8h; buffers evict past this horizon.
    windowHorizonMs: intEnv("WINDOW_HORIZON_MINUTES", 480) * 60_000,
    escalationConfig,
    openclawConfig,
    situationMdPath,
    traceEnabled: boolEnv("TRACE_ENABLED", true),
    traceDir: resolvePath(env("TRACE_DIR", resolve(sinainDataDir(), "traces"))),
    costDisplayEnabled: boolEnv("COST_DISPLAY_ENABLED", false),
    learningConfig,
    privacyConfig,
    permissionsConfig,
  };
}
