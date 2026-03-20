/**
 * sinain-knowledge — Manifest types and loader
 *
 * Reads sinain-knowledge.json configuration with env var interpolation.
 */

import { readFileSync, existsSync } from "node:fs";

// ============================================================================
// Types
// ============================================================================

export interface SinainKnowledgeManifest {
  version: number;
  backend: "openclaw" | "generic";
  workspace: string;
  backupRepo?: string;
  snapshotRepoPath?: string;
  heartbeat?: {
    every: string;
    path?: string;
  };
  skill?: {
    path?: string;
  };
  memory?: {
    path?: string;
  };
  modules?: {
    path?: string;
  };
  alerts?: {
    telegram?: {
      chatId: string;
    };
    webhook?: {
      url: string;
    };
  };
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Interpolate ${ENV_VAR} references in a string.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envVar: string) => {
    return process.env[envVar] ?? "";
  });
}

/**
 * Recursively interpolate env vars in all string values of an object.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load and parse a sinain-knowledge.json manifest file.
 */
export function loadManifest(path: string): SinainKnowledgeManifest {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return interpolateDeep(raw) as SinainKnowledgeManifest;
}
