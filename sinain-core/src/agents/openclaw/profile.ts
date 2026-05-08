import type { AgentsConfig, AgentProfile } from "../../agents-loader.js";

/**
 * OpenClaw-specific profile fields. The base AgentProfile in agents-loader
 * carries these too (loosely typed) for backward compatibility with the
 * heterogeneous JSON schema, but this stricter shape is what the openclaw
 * module actually consumes when it loads its config.
 */
export interface OpenClawProfileFields {
  type: "openclaw";
  wsUrl?: string;
  wsToken?: string;
  httpUrl?: string;
  httpToken?: string;
  sessionKey?: string;
  phase1TimeoutMs?: number;
  phase2TimeoutMs?: number;
  pingIntervalMs?: number;
}

/**
 * Find a gateway-style profile (any profile with `type: "openclaw"`,
 * regardless of the profile's name). Used by sinain-core to:
 *   - load WS connection params at startup (config.ts)
 *   - decide whether a lane choice should route via WS or HTTP (escalator.ts)
 *
 * Preference order: the canonical name "openclaw" wins if present, otherwise
 * the first openclaw-typed profile found in the JSON. This lets users add
 * `nemoclaw`, `nanoclaw-prod`, etc. with their own URLs as drop-in replacements.
 */
export function findGatewayProfile(
  cfg: AgentsConfig | null,
): { name: string; profile: AgentProfile } | null {
  const profiles = cfg?.profiles;
  if (!profiles) return null;
  if (profiles.openclaw?.type === "openclaw") {
    return { name: "openclaw", profile: profiles.openclaw };
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile?.type === "openclaw") return { name, profile };
  }
  return null;
}

/** Is the given profile name a gateway-style (WS-dispatched) profile? */
export function isGatewayProfile(
  cfg: AgentsConfig | null,
  name: string,
): boolean {
  return cfg?.profiles?.[name]?.type === "openclaw";
}

/** All openclaw-typed profile names in the config. */
export function gatewayProfileNames(cfg: AgentsConfig | null): string[] {
  const profiles = cfg?.profiles;
  if (!profiles) return [];
  return Object.entries(profiles)
    .filter(([_, p]) => p?.type === "openclaw")
    .map(([name]) => name);
}
