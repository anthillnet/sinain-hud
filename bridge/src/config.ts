import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BridgeConfig } from "./types.js";

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
      Number(env.RELAY_MIN_INTERVAL_MS) || file.relayMinIntervalMs || 30_000,
  };

  return config;
}
