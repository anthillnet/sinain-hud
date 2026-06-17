// agents-loader.ts
//
// sinain-core's view of sinain-agent-runner/agents.json. Loaded once at startup,
// gives config.ts a typed snapshot of the bare-agent + OpenClaw config that
// used to live in .env.
//
// Why sinain-core reads it at all: the OpenClaw WS client is constructed
// before the bare agent ever registers, and stays connected across the
// session for heartbeat / situation push / feedback. So sinain-core needs
// the gateway URL/token at startup — it can't wait for run.sh to forward
// them via /bareagent/register.
//
// Path resolution:
//   1. AGENTS_CONFIG_PATH env var (explicit override)
//   2. <repo-root>/sinain-agent-runner/agents.json (default)
//   3. <repo-root>/sinain-agent-runner/agents.example.json (fresh-checkout fallback)
//
// Returns null if no candidate exists. config.ts treats null as "use env
// defaults" so the migration is non-breaking.
//
// Field expansion happens in two passes (shell-like ordering):
//   1. Cross-field literal expansion: ${allowedTools} inside escAllowedTools
//      resolves against other top-level fields. Lets users compose
//      whitelists by reference.
//   2. Env-var indirection: ${OPENROUTER_API_KEY}, ${HOME}, etc. resolve
//      against process.env. Mirrors run.sh's apply_profile_env regex
//      (\$\{[A-Za-z_][A-Za-z0-9_]*\}).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regex shared with run.sh's apply_profile_env. Keep the two implementations
// in lockstep when changing either side.
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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

export interface AgentProfile {
  type?: string;
  bin?: string;
  settings?: string;
  model?: string;
  env?: Record<string, string>;
  // openclaw-specific fields (typed loose since profiles are heterogeneous)
  wsUrl?: string;
  wsToken?: string;
  httpUrl?: string;
  httpToken?: string;
  sessionKey?: string;
  phase1TimeoutMs?: number;
  phase2TimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface AnalyzerBlock {
  debounceMs?: number;
  maxIntervalMs?: number;
}

export interface EscalationBlock {
  mode?: string;
  cooldownMs?: number;
  staleMs?: number;
}

export interface AgentsConfig {
  /** Chat/escalation lane default (sinain-eligible). */
  default?: string;
  /** Terminal (interactive TUI) lane default. Decoupled from `default` so the
   *  chat lane can default to the resident sinain sidecar while the terminal —
   *  which needs a real TUI — defaults to a different, sinain-INELIGIBLE agent.
   *  Falls back to the first terminal-eligible profile when unset/invalid. */
  terminalDefault?: string;
  pollIntervalSec?: number;
  agentMaxTurns?: number;
  spawnMaxTurns?: number;
  allowedTools?: string;
  escAllowedTools?: string;
  spawnAllowedTools?: string;
  autoApproveTools?: string;
  analyzer?: AnalyzerBlock;
  escalation?: EscalationBlock;
  profiles?: Record<string, AgentProfile>;
  /** Absolute path of the file actually loaded (for debug logging). */
  loadedFrom?: string;
}

function expandVars(value: string): string {
  return value.replace(VAR_REF_RE, (_, name: string) => process.env[name] ?? "");
}

/** Recursively expand ${env} references in any string field of `obj`. */
function expandEnvDeep<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return expandVars(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((x) => expandEnvDeep(x)) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = expandEnvDeep(v);
    }
    return out as T;
  }
  return obj;
}

/**
 * Cross-field literal expansion at the top level. Lets users write
 *   "escAllowedTools": "${allowedTools} Bash(git:*) Edit"
 * and have it compose with the value of `allowedTools`. Only string
 * top-level fields are eligible to be referenced; nested blocks aren't.
 */
function expandTopLevelRefs(cfg: AgentsConfig): void {
  const refTargets: Record<string, string | undefined> = {
    allowedTools: cfg.allowedTools,
    escAllowedTools: cfg.escAllowedTools,
    spawnAllowedTools: cfg.spawnAllowedTools,
    autoApproveTools: cfg.autoApproveTools,
    default: cfg.default,
  };
  const expand = (s?: string): string | undefined => {
    if (!s) return s;
    return s.replace(VAR_REF_RE, (m, name: string) => {
      const ref = refTargets[name];
      // Only substitute when the referenced field is a top-level field
      // *that has a value*. Otherwise leave the placeholder untouched so
      // the env-var pass can still pick it up (e.g. ${HOME}).
      return ref !== undefined ? ref : m;
    });
  };
  cfg.escAllowedTools = expand(cfg.escAllowedTools);
  cfg.spawnAllowedTools = expand(cfg.spawnAllowedTools);
}

function candidatePaths(): string[] {
  const explicit = process.env.AGENTS_CONFIG_PATH;
  if (explicit) return [resolve(explicit)];
  // ~/.sinain/agents.json is the wizard's write target — works on npm
  // installs where the package dir is read-only. Highest priority after
  // an explicit env override so user-home config wins over the shipped
  // template.
  const userHome = resolve(homedir(), ".sinain", "agents.json");
  // sinain-core compiled output sits at sinain-core/dist/, source at
  // sinain-core/src/. From either, sinain-agent-runner is two levels up.
  const repoRoot = resolve(__dirname, "..", "..");
  return [
    userHome,
    resolve(repoRoot, "sinain-agent-runner", "agents.json"),
    resolve(repoRoot, "sinain-agent-runner", "agents.example.json"),
  ];
}

/**
 * Load agents.json (or fall back to agents.example.json). Returns null if
 * neither candidate file exists or parsing fails. Caller (config.ts) is
 * expected to treat null as "use env defaults" so the migration is
 * non-breaking.
 */
export function loadAgentsConfig(): AgentsConfig | null {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as AgentsConfig;
      // Pass 1: cross-field literal substitution at top level. Has to run
      // before env-var expansion so `${allowedTools}` doesn't accidentally
      // resolve to process.env.allowedTools (which doesn't exist anyway,
      // but the principle of layered substitution is what we want).
      expandTopLevelRefs(parsed);
      // Pass 2: ${ENV_VAR} expansion across the whole tree. Profile-level
      // env blocks are deliberately skipped here — those are applied by
      // run.sh in a subshell at invocation time, not by sinain-core.
      const profiles = parsed.profiles;
      delete parsed.profiles;
      const expanded = expandEnvDeep(parsed);
      // Restore profiles (with their own env blocks expanded for the few
      // openclaw-specific fields that sinain-core does read).
      if (profiles) {
        const expandedProfiles: Record<string, AgentProfile> = {};
        for (const [name, profile] of Object.entries(profiles)) {
          // Don't expand the per-profile `env` block — those are evaluated
          // at agent invocation time inside run.sh. But DO expand other
          // profile fields (wsToken, etc.) since sinain-core reads them.
          const { env: profileEnv, ...rest } = profile;
          expandedProfiles[name] = {
            ...expandEnvDeep(rest),
            ...(profileEnv !== undefined ? { env: profileEnv } : {}),
          };
        }
        expanded.profiles = expandedProfiles;
      }
      expanded.loadedFrom = path;
      return expanded;
    } catch (err) {
      console.warn(`[agents-loader] failed to parse ${path}: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Convenience: pull the openclaw profile if present, else null.
 *  @deprecated Prefer findGatewayProfile() — it doesn't assume the name. */
export function getOpenClawProfile(cfg: AgentsConfig | null): AgentProfile | null {
  return cfg?.profiles?.openclaw ?? null;
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

/** True iff `name` is sinain's bundled resident chat sidecar (type "sinain").
 *  Routed to the local OpenHands sidecar over WS instead of run.sh/gateway. */
export function isSinainProfile(
  cfg: AgentsConfig | null,
  name: string,
): boolean {
  return cfg?.profiles?.[name]?.type === "sinain";
}

/** All openclaw-typed profile names in the config. */
export function gatewayProfileNames(cfg: AgentsConfig | null): string[] {
  const profiles = cfg?.profiles;
  if (!profiles) return [];
  return Object.entries(profiles)
    .filter(([_, p]) => p?.type === "openclaw")
    .map(([name]) => name);
}

/** All sinain-typed (resident chat sidecar) profile names in the config.
 *  Like gateway profiles, these have no PATH binary, so run.sh's roster POST
 *  drops them — sinain-core must inject them into the chat roster itself. */
export function sinainProfileNames(cfg: AgentsConfig | null): string[] {
  const profiles = cfg?.profiles;
  if (!profiles) return [];
  return Object.entries(profiles)
    .filter(([_, p]) => p?.type === "sinain")
    .map(([name]) => name);
}

/** Desktop chat-app profiles (Claude / ChatGPT). Like sinain profiles they have
 *  no PATH binary and are chat-lane-only (no TUI) — core injects them into the
 *  chat roster, gated on the app actually being installed. The deep-link launch
 *  hands the ROI seed to the app; the app pulls it via the sinain_roi MCP tool. */
export function isDesktopProfile(cfg: AgentsConfig | null, name: string): boolean {
  const t = cfg?.profiles?.[name]?.type;
  return t === "claude_desktop" || t === "chatgpt_desktop";
}

export function desktopProfileNames(cfg: AgentsConfig | null): string[] {
  const profiles = cfg?.profiles;
  if (!profiles) return [];
  return Object.entries(profiles)
    .filter(([_, p]) => p?.type === "claude_desktop" || p?.type === "chatgpt_desktop")
    .map(([name]) => name);
}

/** The desktop app type for a profile name, or null. */
export function desktopProfileType(
  cfg: AgentsConfig | null,
  name: string,
): "claude_desktop" | "chatgpt_desktop" | null {
  const t = cfg?.profiles?.[name]?.type;
  return t === "claude_desktop" || t === "chatgpt_desktop" ? t : null;
}
