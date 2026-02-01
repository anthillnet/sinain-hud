import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BridgeConfig, AudioPipelineConfig, TranscriptionConfig, TriggerConfig, SenseConfig } from "./types.js";

const CONFIG_PATH = resolve(process.cwd(), "config.json");
const ENV_PATH = resolve(process.cwd(), ".env");

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  try {
    const raw = readFileSync(ENV_PATH, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch { /* ignore */ }
}

loadDotEnv();

function loadFileConfig(): Partial<BridgeConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const json = JSON.parse(raw);
    return {
      openclawGatewayUrl: json.openclawGatewayUrl ?? json.OPENCLAW_GATEWAY_URL,
      openclawToken: json.openclawToken ?? json.OPENCLAW_TOKEN,
      openclawSessionKey: json.openclawSessionKey ?? json.OPENCLAW_SESSION_KEY,
      wsPort: json.wsPort ?? json.WS_PORT,
      relayMinIntervalMs: json.relayMinIntervalMs ?? json.RELAY_MIN_INTERVAL_MS,
    };
  } catch {
    return {};
  }
}

function loadAudioConfig(): AudioPipelineConfig {
  const env = process.env;
  return {
    device: env.AUDIO_DEVICE ?? "default",
    sampleRate: Number(env.AUDIO_SAMPLE_RATE) || 16000,
    channels: 1,
    chunkDurationMs: Number(env.AUDIO_CHUNK_MS) || 5000,
    vadEnabled: env.AUDIO_VAD_ENABLED !== "false",
    vadThreshold: Number(env.AUDIO_VAD_THRESHOLD) || 0.003,
    captureCommand: (env.AUDIO_CAPTURE_CMD === "ffmpeg" ? "ffmpeg" : "sox") as "sox" | "ffmpeg",
    autoStart: env.AUDIO_AUTO_START === "true",
    gainDb: Number(env.AUDIO_GAIN_DB) || 20,
  };
}

function loadTriggerConfig(): TriggerConfig {
  const env = process.env;
  return {
    enabled: env.TRIGGER_ENABLED === "true",
    model: env.TRIGGER_MODEL ?? "google/gemini-2.5-flash",
    apiKey: env.OPENROUTER_API_KEY ?? "",
  };
}

function loadTranscriptionConfig(): TranscriptionConfig {
  const env = process.env;
  const backend = env.TRANSCRIPTION_BACKEND;
  let resolvedBackend: TranscriptionConfig["backend"] = "openrouter";
  if (backend === "aws-gemini" || backend === "whisper") {
    resolvedBackend = backend;
  }
  return {
    backend: resolvedBackend,
    awsRegion: env.AWS_REGION ?? "eu-west-1",
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
    openrouterApiKey: env.OPENROUTER_API_KEY ?? "",
    geminiModel: env.GEMINI_MODEL ?? "google/gemini-2.5-flash",
    refineIntervalMs: Number(env.REFINE_INTERVAL_MS) || 30000,
    language: env.TRANSCRIPTION_LANGUAGE ?? "en-US",
  };
}

function loadSenseConfig(): SenseConfig {
  const env = process.env;
  return {
    enabled: env.SENSE_ENABLED === "true",
    pollIntervalMs: Number(env.SENSE_POLL_INTERVAL_MS) || 5000,
  };
}

export function loadConfig(): BridgeConfig {
  const file = loadFileConfig();
  const env = process.env;

  const config: BridgeConfig = {
    openclawGatewayUrl:
      env.OPENCLAW_GATEWAY_URL ?? file.openclawGatewayUrl ?? "http://localhost:3000",
    openclawToken:
      env.OPENCLAW_TOKEN ?? file.openclawToken ?? "",
    openclawSessionKey:
      env.OPENCLAW_SESSION_KEY ?? file.openclawSessionKey ?? "",
    wsPort:
      Number(env.WS_PORT) || file.wsPort || 9500,
    relayMinIntervalMs:
      Number(env.RELAY_MIN_INTERVAL_MS) || file.relayMinIntervalMs || 10_000,
    audioConfig: loadAudioConfig(),
    audioAltDevice: env.AUDIO_ALT_DEVICE ?? "BlackHole 2ch",
    transcriptionConfig: loadTranscriptionConfig(),
    triggerConfig: loadTriggerConfig(),
    senseConfig: loadSenseConfig(),
  };

  return config;
}
