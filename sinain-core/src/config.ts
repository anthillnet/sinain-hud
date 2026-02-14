import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { CoreConfig, AudioPipelineConfig, TranscriptionConfig, AgentConfig, EscalationConfig, OpenClawConfig, EscalationMode, LearningConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(): void {
  // Try sinain-core/.env first, then project root .env
  const candidates = [
    resolve(__dirname, "..", ".env"),
    resolve(__dirname, "..", "..", ".env"),
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

function resolvePath(p: string): string {
  return p.replace(/^~/, os.homedir());
}

export function loadConfig(): CoreConfig {
  const audioConfig: AudioPipelineConfig = {
    device: env("AUDIO_DEVICE", "BlackHole 2ch"),
    sampleRate: intEnv("AUDIO_SAMPLE_RATE", 16000),
    channels: 1,
    chunkDurationMs: intEnv("AUDIO_CHUNK_MS", 5000),
    vadEnabled: boolEnv("AUDIO_VAD_ENABLED", true),
    vadThreshold: floatEnv("AUDIO_VAD_THRESHOLD", 0.001),
    captureCommand: env("AUDIO_CAPTURE_CMD", "ffmpeg") as "sox" | "ffmpeg",
    autoStart: boolEnv("AUDIO_AUTO_START", true),
    gainDb: intEnv("AUDIO_GAIN_DB", 20),
  };

  const transcriptionConfig: TranscriptionConfig = {
    openrouterApiKey: env("OPENROUTER_API_KEY", ""),
    geminiModel: env("TRANSCRIPTION_MODEL", "google/gemini-2.5-flash"),
    language: env("TRANSCRIPTION_LANGUAGE", "en-US"),
  };

  const agentConfig: AgentConfig = {
    enabled: boolEnv("AGENT_ENABLED", true),
    model: env("AGENT_MODEL", "google/gemini-2.5-flash-lite"),
    visionModel: env("AGENT_VISION_MODEL", "google/gemini-2.5-flash"),
    visionEnabled: boolEnv("AGENT_VISION_ENABLED", true),
    openrouterApiKey: env("OPENROUTER_API_KEY", ""),
    maxTokens: intEnv("AGENT_MAX_TOKENS", 800),
    temperature: floatEnv("AGENT_TEMPERATURE", 0.3),
    pushToFeed: boolEnv("AGENT_PUSH_TO_FEED", true),
    debounceMs: intEnv("AGENT_DEBOUNCE_MS", 3000),
    maxIntervalMs: intEnv("AGENT_MAX_INTERVAL_MS", 30000),
    cooldownMs: intEnv("AGENT_COOLDOWN_MS", 10000),
    maxAgeMs: intEnv("AGENT_MAX_AGE_MS", 120000),
    fallbackModels: env("AGENT_FALLBACK_MODELS", "google/gemini-2.5-flash,anthropic/claude-3.5-haiku")
      .split(",").map(s => s.trim()).filter(Boolean),
    historyLimit: intEnv("AGENT_HISTORY_LIMIT", 50),
  };

  const escalationMode = env("ESCALATION_MODE", "rich") as EscalationMode;
  const escalationConfig: EscalationConfig = {
    mode: escalationMode,
    cooldownMs: intEnv("ESCALATION_COOLDOWN_MS", 30000),
  };

  const openclawConfig: OpenClawConfig = {
    gatewayWsUrl: env("OPENCLAW_WS_URL", env("OPENCLAW_GATEWAY_WS_URL", "ws://localhost:18789")),
    gatewayToken: env("OPENCLAW_WS_TOKEN", env("OPENCLAW_GATEWAY_TOKEN", "")),
    hookUrl: env("OPENCLAW_HTTP_URL", env("OPENCLAW_HOOK_URL", "http://localhost:18789/hooks/agent")),
    hookToken: env("OPENCLAW_HTTP_TOKEN", env("OPENCLAW_HOOK_TOKEN", "")),
    sessionKey: env("OPENCLAW_SESSION_KEY", "agent:main:sinain"),
  };

  const situationDir = env("OPENCLAW_WORKSPACE_DIR", "~/.openclaw/workspace");
  const situationMdPath = resolvePath(
    env("SITUATION_MD_PATH", `${situationDir}/SITUATION.md`)
  );

  const learningConfig: LearningConfig = {
    enabled: boolEnv("LEARNING_ENABLED", true),
    feedbackDir: resolvePath(env("FEEDBACK_DIR", "~/.sinain-core/feedback")),
    retentionDays: intEnv("FEEDBACK_RETENTION_DAYS", 30),
  };

  return {
    port: intEnv("PORT", 9500),
    audioConfig,
    audioAltDevice: env("AUDIO_ALT_DEVICE", "BlackHole 2ch"),
    transcriptionConfig,
    agentConfig,
    escalationConfig,
    openclawConfig,
    situationMdPath,
    traceEnabled: boolEnv("TRACE_ENABLED", true),
    traceDir: resolvePath(env("TRACE_DIR", "~/.sinain-core/traces")),
    learningConfig,
  };
}
