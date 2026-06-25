import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { loadAgentsConfig, isGatewayProfile, isSinainProfile, gatewayProfileNames, sinainProfileNames, isDesktopProfile, desktopProfileNames, desktopProfileType } from "./agents-loader.js";
import { roiSeeds } from "./chat/roi-seeds.js";
import { launchDesktop, desktopAppInstalled } from "./chat/desktop-launch.js";
import { ChatService } from "./chat/chat-service.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { setupCommands } from "./overlay/commands.js";
import { AudioPipeline } from "./audio/pipeline.js";
import type { CaptureSpawner } from "./audio/capture-spawner.js";
import { TranscriptionService } from "./audio/transcription.js";
import { AgentLoop } from "./agent/loop.js";
import { RegionTracker, buildRegionTaskText } from "./agent/region-tracker.js";
import { RegionDetector } from "./agent/region-detector.js";
import { TunnelController } from "./mcp-tunnel/controller.js";
import { shortAppName } from "./agent/context-window.js";
import { Escalator } from "./escalation/escalator.js";
import { Recorder } from "./recorder.js";
import { Tracer } from "./trace/tracer.js";
import { TraceStore } from "./trace/trace-store.js";
import { FeedbackStore } from "./learning/feedback-store.js";
import { SignalCollector } from "./learning/signal-collector.js";
import { LocalCurationService } from "./learning/local-curation.js";
import { EmbeddingService } from "./embedding/service.js";
import { createAppServer } from "./server.js";
import { WebDb } from "./web-db/store.js";
import { Profiler } from "./profiler.js";
import { CostTracker } from "./cost/tracker.js";
import type { SenseEvent, EscalationMode, FeedItem, RawRegion, ContextWindow } from "./types.js";
import { isDuplicateTranscript, bigramSimilarity } from "./util/dedup.js";
import { log, warn, error, debug } from "./log.js";
import { initPrivacy, levelFor, applyLevel } from "./privacy/index.js";

// Brand this process so it shows as "sinain-core" (not bare "node") in Activity
// Monitor / `ps` — so users can recognise + clean up our services. macOS reads
// the name from process.title once set.
process.title = "sinain-core";

const TAG = "core";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, "..", "..");

/**
 * Python interpreter for the sinain-memory scripts (graph_query, page_renderer,
 * distillers). In a packaged build the launcher sets SINAIN_PYTHON to the one
 * interpreter that has the deps — bare "python3" can resolve to a dep-less
 * install and make knowledge pages silently fall back to empty.
 */
const PYTHON_BIN = process.env.SINAIN_PYTHON || "python3";

/** Directory containing the sense_client package (for `python3 -m` one-shots).
 *  Dev/monorepo: <repo> (two up from sinain-core/src); DMG/npm layouts keep
 *  sense_client a sibling of sinain-core the same way. */
const SENSE_PKG_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [resolve(here, "..", ".."), resolve(here, "..")];
  return cands.find((p) => existsSync(`${p}/sense_client`)) || cands[0];
})();

/** Resolve workspace path, expanding leading ~ to HOME. */
function resolveWorkspace(): string {
  const raw = process.env.SINAIN_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;
  return raw.startsWith("~") ? raw.replace("~", process.env.HOME || "") : raw;
}

/** Resolve the local memory directory (independent of OpenClaw workspace). */
function resolveLocalMemoryDir(): string {
  const raw = process.env.SINAIN_MEMORY_DIR || `${process.env.HOME}/.sinain/memory`;
  return raw.startsWith("~") ? raw.replace("~", process.env.HOME || "") : raw;
}

/** Persisted overlay/UI preferences that must survive core restarts. Kept in a
 *  tiny JSON next to the memory dir so an explicit choice (e.g. idle messages
 *  ON) isn't silently reset to the default on the next launch. */
function resolveUiPrefsPath(): string {
  return `${resolve(resolveLocalMemoryDir(), "..")}/ui-prefs.json`;
}

interface UiPrefs {
  /** Ambient/idle (unsolicited) HUD messages. Default OFF — the user opts in. */
  idleMessagesEnabled: boolean;
}

function loadUiPrefs(): UiPrefs {
  const defaults: UiPrefs = { idleMessagesEnabled: false };
  try {
    const p = resolveUiPrefsPath();
    if (!existsSync(p)) return defaults;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return { idleMessagesEnabled: parsed?.idleMessagesEnabled === true };
  } catch {
    return defaults;
  }
}

function saveUiPrefs(prefs: UiPrefs): void {
  try {
    const p = resolveUiPrefsPath();
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(prefs, null, 2));
  } catch {
    /* best-effort — a failed write just means the choice won't persist */
  }
}

function resolveLocalAgentScript(): string | null {
  const candidates = [
    resolve(PACKAGE_ROOT, "sinain-agent-runner", "run.sh"),
    resolve(process.cwd(), "..", "sinain-agent-runner", "run.sh"),
    resolve(process.cwd(), "sinain-agent-runner", "run.sh"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function resolveChatSidecar(): string | null {
  const candidates = [
    resolve(PACKAGE_ROOT, "sinain-chat-agent", "sidecar.py"),
    resolve(process.cwd(), "..", "sinain-chat-agent", "sidecar.py"),
    resolve(process.cwd(), "sinain-chat-agent", "sidecar.py"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function writeLocalAgentMcpConfig(port: number): string {
  const tmpDir = resolve(homedir(), ".sinain", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tsxBin = resolve(PACKAGE_ROOT, "sinain-core", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const configPath = resolve(tmpDir, "mcp-config.json");
  const config = {
    mcpServers: {
      sinain: {
        command: tsxBin,
        args: [resolve(PACKAGE_ROOT, "sinain-mcp-server", "index.ts")],
        env: {
          SINAIN_CORE_URL: process.env.SINAIN_CORE_URL || `http://localhost:${port}`,
          SINAIN_WORKSPACE: resolveWorkspace(),
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function pipeLocalAgentOutput(stream: NodeJS.ReadableStream, sink: (line: string) => void): void {
  const rl = createInterface({ input: stream });
  rl.on("line", sink);
}

/**
 * Query knowledge facts from both local and workspace databases.
 * Checks local (~/.sinain/memory) first, then workspace (~/.openclaw/workspace/memory).
 * Merges results, deduplicates, returns up to maxFacts.
 */
/** Unix socket the warm KG daemon (kg_daemon.py) listens on. */
const KG_SOCK = process.env.SINAIN_KG_SOCK || "/tmp/sinain-kg.sock";

/** Ask the warm KG daemon for lean RRF candidates (it holds the Oxigraph stores
 *  + FTS resident read-only). Returns null on any unreachable/slow/error so the
 *  caller transparently falls back to a one-shot graph_query.py spawn. */
async function kgDaemonCandidates(
  entities: string[],
  queryText: string | undefined,
  maxFacts: number,
  dbPaths: string[],
): Promise<Array<Record<string, string>> | null> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: Array<Record<string, string>> | null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(val);
    };
    const sock = net.connect(KG_SOCK);
    sock.setTimeout(4000, () => finish(null));
    sock.on("error", () => finish(null));
    sock.on("connect", () => {
      sock.write(JSON.stringify({
        op: "roi", query: queryText || "", entities,
        dbs: dbPaths, max_facts: maxFacts * 2,
      }) + "\n");
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const facts = JSON.parse(buf.slice(0, nl)).facts;
        finish(Array.isArray(facts) ? facts as Array<Record<string, string>> : null);
      } catch { finish(null); }
    });
  });
}

async function queryKnowledgeFactsMulti(entities: string[], maxFacts: number, queryText?: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { resolve } = await import("node:path");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  // Candidate database paths (local first, then workspace)
  const localDir = resolveLocalMemoryDir();
  const workspaceDir = `${resolveWorkspace()}/memory`;
  const dbPaths = [
    `${localDir}/knowledge-graph.db`,
    `${workspaceDir}/knowledge-graph.db`,
  ];

  // Step 1: get RRF candidates. Prefer the warm KG daemon (Oxigraph stores +
  // FTS resident read-only → ~0.3-0.7s vs the ~5-10s cold spawn, which on a
  // large store brushed the 10s timeout and effectively broke enrichment). Fall
  // back to a one-shot graph_query.py spawn if the daemon is down/slow. Either
  // way these are CANDIDATES — Step 2 re-ranks in-process — so the source is
  // interchangeable. Both use the lean profile (FTS + tag, no graph expansion).
  let candidateFacts = await kgDaemonCandidates(entities, queryText, maxFacts, dbPaths);
  if (candidateFacts === null) {
    const scriptPath = resolveSinainMemoryScript("graph_query.py");
    // Query the stores CONCURRENTLY (separate Oxigraph paths, no lock
    // contention) so latency is the slowest store, not the sum. --no-semantic:
    // keyword expansion would load MiniLM in the one-shot python (~4s); we
    // re-rank with in-process embeddings in Step 2.
    const perDb = await Promise.all(dbPaths.map(async (dbPath) => {
      if (!existsSync(dbPath)) return [] as Array<Record<string, string>>;
      try {
        const args = [scriptPath, "--db", dbPath, "--max-facts", String(maxFacts * 2), "--format", "json", "--no-semantic", "--no-raw-excerpts"];
        if (entities.length > 0) args.push("--entities", JSON.stringify(entities));
        const { stdout } = await execFileAsync(PYTHON_BIN, args, { timeout: 10000, encoding: "utf-8" });
        const out = stdout.trim();
        if (!out) return [] as Array<Record<string, string>>;
        const parsed = JSON.parse(out);
        const facts = parsed.facts || parsed;
        return Array.isArray(facts) ? facts as Array<Record<string, string>> : [];
      } catch { return [] as Array<Record<string, string>>; }
    }));
    candidateFacts = perDb.flat();
  }

  // Keep durable knowledge; drop episodic activity. The graph is dominated by
  // session activity (domain "session": ~1200 vs ~25 durable) which, being
  // topically close to any work ROI, otherwise floods the "long-term knowledge"
  // section with logs of what the user did. Two episodic shapes:
  //   • kind="verbatim" — raw per-tick observations ("Reviewing X in Zed").
  //   • timestamp-keyed session digests (`fact:2026-06-18t08_08-…`) — "the user
  //     spent the session editing X".
  // The CURRENT activity is already carried by the situation digest; this
  // section should be durable facts (preferences, decisions, relationships).
  const SESSION_DIGEST_ID = /^fact:\d{4}-\d{2}-\d{2}t\d{2}_\d{2}-/;
  candidateFacts = candidateFacts.filter(
    (f) =>
      (f as any).kind !== "verbatim" &&
      !SESSION_DIGEST_ID.test(String((f as any).entity_id || "")),
  );

  if (candidateFacts.length === 0) return "";

  // Step 2: Re-rank by embedding similarity in-process (no deadlock — model is
  // in this process). Prefer the caller's rich query text (e.g. the ROI's
  // on-screen content) over the bare entity slugs — the slugs are a coarse
  // recall net (generic words like "posted/while/keep" match random sessions),
  // so the embedding query must represent what's ACTUALLY on screen to rank by.
  const embedQuery = (queryText && queryText.trim()) ? queryText.trim() : entities.join(" ");
  try {
    if (embeddingService?.ready) {
      const allTexts = [embedQuery, ...candidateFacts.map(f => f.value || "")];
      const embeddings = await embeddingService.embed(allTexts);
      const queryEmb = embeddings[0];
      const scored = candidateFacts.map((f, i) => ({
        fact: f,
        sim: EmbeddingService.cosine(queryEmb, embeddings[i + 1]),
      }));
      scored.sort((a, b) => b.sim - a.sim);
      // Relevance floor: a seed should surface facts ABOUT the ROI, not the
      // top-N of whatever vaguely matched the entity slugs. Below the floor the
      // facts are unrelated — drop them (an empty knowledge section is the
      // correct result for novel on-screen content, not a pile of off-topic
      // session digests).
      const RELEVANCE_FLOOR = 0.30;
      candidateFacts.length = 0;
      candidateFacts.push(
        ...scored.filter((s) => s.sim >= RELEVANCE_FLOOR).slice(0, maxFacts).map((s) => s.fact),
      );
    }
  } catch { /* embedding unavailable — use RRF order */ }

  // Step 3: Format as a clean fact list. Values are self-contained sentences —
  // emit them as bullets WITHOUT the internal entity-id hash or
  // (confidence,count) metadata, which read as noise in an LLM seed. Drop
  // empty/fragment values and any raw episodic excerpt that slipped past the
  // Python --no-raw-excerpts gate (belt-and-suspenders).
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  const maxChars = 1200;
  for (const f of candidateFacts.slice(0, maxFacts)) {
    if ((f as any).source === "raw-excerpt" || (f as any).entity === "excerpt") continue;
    const value = String((f as any).value || "").trim();
    if (value.length < 8) continue; // skip empty / fragment values
    const key = value.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `- ${value}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/** Build the "long-term knowledge" block for an ROI seed: facts RANKED against
 *  the ROI's on-screen content, filtered to distilled non-episodic facts.
 *
 *  We rank FACTS (not entities) against the ROI because auto entity-selection
 *  lands on generic mega-buckets (`user`/`sinain`/`claude`, thousands of facts)
 *  whose page summaries are useless ("the user works with IntelliJ/Zed/Slack").
 *  The web UI's entity pages read well because the human clicks the SPECIFIC
 *  entity — fact-level ranking against the actual screen text is the auto
 *  equivalent, surfacing the on-topic facts (e.g. the thread-handoff ones for a
 *  thread-handoff ROI) directly. */
async function buildRoiKnowledge(region: { issue: string; sourceOcr?: string; app?: string }): Promise<string> {
  const roiText = `${region.issue}\n${region.sourceOcr ?? ""}`.slice(0, 1200);
  const entities = [
    ...(region.app ? [region.app.toLowerCase().replace(/\s+/g, "-")] : []),
    ...region.issue.toLowerCase().split(/[^a-z0-9а-яё-]+/i).filter((w) => w.length > 3).slice(0, 5),
  ];
  if (entities.length === 0) return "";
  return queryKnowledgeFactsMulti(entities, 8, roiText);
}

// Per-ROI knowledge cache. Warmed when a region is DETECTED (pushRegions) so
// engaging it is INSTANT instead of waiting on retrieval — the KG daemon makes
// each prefetch ~0.5s, cheap enough to keep the visible ROIs hot. Keyed by ROI
// content (app + issue + an OCR slice), so position-only re-anchors hit the
// cache and don't re-query; TTL bounds staleness; size-bounded LRU-ish.
const ROI_KNOWLEDGE_TTL_MS = Number(process.env.ROI_KNOWLEDGE_TTL_MS) || 90_000;
const roiKnowledgeCache = new Map<string, { knowledge: Promise<string>; ts: number }>();
function roiKnowledgeKey(region: { issue: string; sourceOcr?: string; app?: string }): string {
  return `${(region.app ?? "").toLowerCase()}|${region.issue.toLowerCase().slice(0, 120)}|${(region.sourceOcr ?? "").slice(0, 80)}`;
}
/** buildRoiKnowledge, memoized by ROI content so a detect-time prefetch is reused
 *  on engage. Always resolves to a string (errors → ""). */
function buildRoiKnowledgeCached(region: { issue: string; sourceOcr?: string; app?: string }): Promise<string> {
  const key = roiKnowledgeKey(region);
  const hit = roiKnowledgeCache.get(key);
  if (hit && Date.now() - hit.ts < ROI_KNOWLEDGE_TTL_MS) return hit.knowledge;
  const knowledge = buildRoiKnowledge(region).catch(() => "");
  roiKnowledgeCache.set(key, { knowledge, ts: Date.now() });
  if (roiKnowledgeCache.size > 24) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of roiKnowledgeCache) if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    if (oldestKey) roiKnowledgeCache.delete(oldestKey);
  }
  return knowledge;
}

// Reference to embedding service — set during init
let embeddingService: import("./embedding/service.js").EmbeddingService | null = null;

/** List all entities from both local and workspace knowledge graphs. */
async function listKnowledgeEntitiesMulti(max: number): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const localDir = resolveLocalMemoryDir();
  const workspaceDir = `${resolveWorkspace()}/memory`;
  const dbPaths = [
    `${localDir}/knowledge-graph.db`,
    `${workspaceDir}/knowledge-graph.db`,
  ];

  const scriptPath = resolveSinainMemoryScript("graph_query.py");

  const allFacts: any[] = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync(PYTHON_BIN, [
        scriptPath, "--db", dbPath, "--top", String(max), "--format", "json",
      ], { timeout: 5000, encoding: "utf-8" });
      const parsed = JSON.parse(out);
      if (parsed.facts) allFacts.push(...parsed.facts);
    } catch { /* skip */ }
  }

  // Deduplicate by entityId, merge
  const seen = new Set<string>();
  const unique = allFacts.filter(f => {
    const id = f.entityId || "";
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return JSON.stringify(unique.slice(0, max));
}

/**
 * Resolve a Python script under sinain-memory/. Two layouts are supported:
 *
 * - **dev repo**: code is at `<repo>/sinain-core/src/index.ts`, scripts at
 *   `<repo>/sinain-hud-plugin/sinain-memory/<name>` (so `__dir/../../sinain-hud-plugin/sinain-memory`).
 * - **npm-installed**: code is at `node_modules/@geravant/sinain/sinain-core/src/index.ts`,
 *   scripts at `node_modules/@geravant/sinain/sinain-memory/<name>` (so `__dir/../../sinain-memory`).
 *
 * Plus a workspace fallback for OpenClaw layouts. ENOENT on the resolved
 * path was Irina's bug — the npm path was missing from candidates.
 */
function resolveSinainMemoryScript(scriptName: string): string {
  const __dir = new URL(import.meta.url).pathname.replace(/\/[^/]+$/, "");
  const candidates = [
    `${__dir}/../../sinain-hud-plugin/sinain-memory/${scriptName}`,  // dev repo
    `${__dir}/../../sinain-memory/${scriptName}`,                      // npm install
    `${__dir}/../sinain-memory/${scriptName}`,                         // legacy
    `${resolveWorkspace()}/sinain-memory/${scriptName}`,               // openclaw workspace
  ];
  return candidates.find(p => existsSync(p)) || candidates[0];
}

/** Backward-compat alias used by legacy call sites. */
function resolveGraphQueryScript(): string {
  return resolveSinainMemoryScript("graph_query.py");
}

/** List of candidate knowledge DB paths (local + workspace). */
function resolveKnowledgeDbPaths(): string[] {
  return [
    `${resolveLocalMemoryDir()}/knowledge-graph.db`,
    `${resolveWorkspace()}/memory/knowledge-graph.db`,
  ];
}

/** Search entities across all knowledge DBs. Returns ranked list with snippets. */
async function searchEntitiesMulti(query: string, limit: number): Promise<unknown> {
  const { execFileSync } = await import("node:child_process");
  const scriptPath = resolveGraphQueryScript();
  const merged: Map<string, any> = new Map();
  let topicFallback = true;

  for (const dbPath of resolveKnowledgeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync(PYTHON_BIN, [
        scriptPath, "--db", dbPath,
        "--search-entities", query,
        "--search-limit", String(limit * 2), // 2x then de-dup
      ], { timeout: 5000, encoding: "utf-8" });
      const parsed = JSON.parse(out);
      if (!parsed.topic_fallback) topicFallback = false;
      for (const r of parsed.results || []) {
        const existing = merged.get(r.entity);
        if (!existing || existing.score < r.score) {
          merged.set(r.entity, r);
        } else {
          existing.fact_count += r.fact_count; // sum across DBs when same entity present
        }
      }
    } catch (err) {
      // Skip a failed DB, but LOG it. This catch fires on PROCESS-level failures
      // (timeout, interpreter/import crash) — distinct from graph_query.py's own
      // internal try/except, which swallowed the post-migration '_conn' crash to
      // stderr + exit 0 and made the web UI show empty memories with no trace. A
      // crash and a genuinely-empty store must never look the same to the caller.
      warn(TAG, `searchEntities: DB query failed (${dbPath}): ${(err as Error).message}`);
    }
  }

  const results = Array.from(merged.values())
    .sort((a, b) => (b.score - a.score) || (b.fact_count - a.fact_count))
    .slice(0, limit);

  return { results, topic_fallback: topicFallback && results.every(r => r.score < 0.4) };
}

/** Export a concept bundle (entity + neighborhood) as JSON. */
async function exportConceptBundle(
  entity: string,
  depth: number,
  opts: { includeRetracted: boolean; includePage: boolean; redactRules: string[] },
): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const pExecFile = promisify(execFile);
  const scriptPath = resolveSinainMemoryScript("concept_export.py");
  const webDbPath = `${resolveLocalMemoryDir()}/web.db`;

  for (const dbPath of resolveKnowledgeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    const args = [
      scriptPath,
      "--db", dbPath,
      "--root", entity,
      "--depth", String(depth),
      "--web-db", webDbPath,
      "--redact", opts.redactRules.join(","),
    ];
    if (opts.includeRetracted) args.push("--include-retracted");
    if (opts.includePage) args.push("--include-page");
    try {
      // 30s budget — large 2-hop exports can take time on big graphs.
      const { stdout } = await pExecFile(PYTHON_BIN, args,
        { timeout: 30_000, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      // If the export found at least one entity (the root), return it.
      // BFS always includes the root in `visited`, so entities >= 1 always —
      // not a useful guard. Check for actual triples instead, otherwise we
      // accept a bundle that has just the root with no data and never try
      // the next DB. This was the bug that produced empty parloa bundles
      // when entity:parloa lived in the workspace DB but local was checked
      // first and returned an empty (root-only) bundle.
      if (parsed.stats && parsed.stats.triples > 0) return parsed;
    } catch (e) {
      // try next DB
    }
  }
  return { ok: false, error: "entity not found in any knowledge graph" };
}

/** Import a concept bundle into the local knowledge graph. */
async function importConceptBundle(
  envelope: unknown,
  conflict: "skip" | "merge" | "overwrite",
): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const pExecFile = promisify(execFile);
  const scriptPath = resolveSinainMemoryScript("concept_import.py");
  const localDir = resolveLocalMemoryDir();
  const dbPath = `${localDir}/knowledge-graph.db`;
  const webDbPath = `${localDir}/web.db`;

  // Pipe envelope to stdin via spawn to avoid huge command-line args.
  // (execFile doesn't accept stdin input — that's a spawn-only option.)
  const args = [
    scriptPath,
    "--db", dbPath,
    "--web-db", webDbPath,
    "--bundle", "-",
    "--conflict", conflict,
  ];
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, args, { timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `python exited ${code}: ${stderr.slice(0, 300)}` });
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e: any) { resolve({ ok: false, error: `parse failed: ${e.message}` }); }
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

/** Retract or restore a fact entity via the Python retract.py subprocess. */
async function retractOrRestoreFact(
  mode: "retract" | "restore",
  factId: string,
  opts: { reason?: string | null; actor?: string | null; sourceEntity?: string | null; undoToken?: string },
): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const pExecFile = promisify(execFile);
  const scriptPath = resolveSinainMemoryScript("retract.py");
  const webDbPath = `${resolveLocalMemoryDir()}/web.db`;

  // Try DBs in order — the fact lives in one of them.
  for (const dbPath of resolveKnowledgeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    const args = [
      scriptPath,
      "--db", dbPath,
      "--web-db", webDbPath,
      "--fact-id", factId,
      mode === "retract" ? "--retract" : "--restore",
    ];
    if (mode === "retract") {
      if (opts.reason) args.push("--reason", opts.reason);
      if (opts.actor) args.push("--actor", opts.actor);
      if (opts.sourceEntity) args.push("--source-entity", opts.sourceEntity);
    } else {
      if (opts.undoToken) args.push("--undo-token", opts.undoToken);
    }
    try {
      const { stdout } = await pExecFile(PYTHON_BIN, args, { timeout: 10_000, encoding: "utf-8" });
      const parsed = JSON.parse(stdout);
      if (parsed.ok) return parsed;
      // If error is "fact not found" try the next DB; otherwise return the error
      if (!String(parsed.error || "").includes("not found")) return parsed;
    } catch (e) {
      // continue to next DB
    }
  }
  return { ok: false, error: "fact not found in any knowledge graph" };
}

/** Render a Confluence-style page for an entity via Python LLM script. */
async function renderEntityPageMulti(
  entity: string,
  opts: { refresh: boolean; maxFacts: number; model?: string },
): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const pExecFile = promisify(execFile);
  const scriptPath = resolveSinainMemoryScript("page_renderer.py");
  const webDbPath = `${resolveLocalMemoryDir()}/web.db`;

  // Try DBs in order; first one with the entity wins.
  for (const dbPath of resolveKnowledgeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    const args = [
      scriptPath,
      "--db", dbPath,
      "--entity", entity,
      "--max-facts", String(opts.maxFacts),
      "--web-db", webDbPath,
    ];
    if (opts.refresh) args.push("--refresh");
    try {
      // Per-call model override (the seed routes to a local SLM for a fast,
      // free, parallel render; the web UI keeps the cloud default).
      const execOpts: { timeout: number; encoding: "utf-8"; env?: NodeJS.ProcessEnv } = {
        timeout: 60_000, encoding: "utf-8",
      };
      if (opts.model) execOpts.env = { ...process.env, SINAIN_PAGE_MODEL: opts.model };
      // 60s budget — LLM rendering for large entities can take 20-30s.
      const { stdout } = await pExecFile(PYTHON_BIN, args, execOpts);
      const parsed = JSON.parse(stdout);
      if (parsed.fact_count > 0) return parsed;
    } catch (e) {
      // continue to next DB
    }
  }
  // No DB had the entity — return an empty page rather than 404 so the UI can show empty state.
  return {
    entity,
    tx_watermark: 0,
    fact_count: 0,
    facts_used: 0,
    summary: "No knowledge captured for this entity yet.",
    sections: [],
    stats: { from_cache: false, tokens_in: 0, tokens_out: 0, dropped_bullets: 0 },
  };
}

/** Lazy-load graph children for an entity. Local DB first, workspace as fallback. */
async function graphChildrenMulti(entity: string): Promise<unknown> {
  const { execFileSync } = await import("node:child_process");
  const scriptPath = resolveGraphQueryScript();

  for (const dbPath of resolveKnowledgeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync(PYTHON_BIN, [
        scriptPath, "--db", dbPath,
        "--graph-children", entity,
        "--graph-limit", "50",
      ], { timeout: 5000, encoding: "utf-8" });
      const parsed = JSON.parse(out);
      if (parsed.groups && parsed.groups.length > 0) return parsed;
    } catch { /* skip */ }
  }
  return { entity, groups: [] };
}

/** Bi-temporal entity query: what did we know about entity X on a given date? */
async function queryKnowledgeAsOfMulti(entity: string, date: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { dirname } = await import("node:path");

  const localDir = resolveLocalMemoryDir();
  const workspaceDir = `${resolveWorkspace()}/memory`;
  const dbPaths = [
    `${localDir}/knowledge-graph.db`,
    `${workspaceDir}/knowledge-graph.db`,
  ];

  const __dir = dirname(new URL(import.meta.url).pathname);
  const scriptCandidates = [
    `${__dir}/../../sinain-hud-plugin/sinain-memory`,  // dev repo
    `${__dir}/../../sinain-memory`,                     // npm install
    `${__dir}/../sinain-memory`,                        // legacy
    `${resolveWorkspace()}/sinain-memory`,              // workspace
  ];
  const scriptsDir = scriptCandidates.find(p => existsSync(`${p}/triplestore.py`)) || scriptCandidates[0];

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      // SECURITY: entity/date are caller-supplied. The program text is a fixed
      // constant; all dynamic values are passed as argv (sys.argv[1..4]) so they
      // enter Python as runtime string data and can never be parsed as code.
      const pyCode = `
import sys, json
sys.path.insert(0, sys.argv[1])
from datetime import datetime
from triplestore import TripleStore
store = TripleStore(sys.argv[2])
d = datetime.fromisoformat(sys.argv[3])
entity = sys.argv[4]
# Query both entity:X and fact:X-* patterns
result = store.entity_as_of("entity:" + entity, d)
if not result:
    result = store.entity_as_of(entity, d)
print(json.dumps({k: v for k, v in result.items()}, ensure_ascii=False))
`;
      const out = execFileSync(
        PYTHON_BIN,
        ["-c", pyCode, scriptsDir, dbPath, date, entity],
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (out && out !== "{}") return out;
    } catch { /* skip */ }
  }
  return "{}";
}

/** Export knowledge facts as a portable JSON module. */
async function exportKnowledgeMulti(domain: string | null, max: number): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const localDir = resolveLocalMemoryDir();
  const workspaceDir = `${resolveWorkspace()}/memory`;
  const dbPaths = [
    `${localDir}/knowledge-graph.db`,
    `${workspaceDir}/knowledge-graph.db`,
  ];

  const scriptPath = resolveSinainMemoryScript("graph_query.py");

  const allFacts: any[] = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync(PYTHON_BIN, [
        scriptPath, "--db", dbPath, "--top", String(max), "--format", "json",
      ], { timeout: 5000, encoding: "utf-8" });
      const parsed = JSON.parse(out);
      if (parsed.facts) allFacts.push(...parsed.facts);
    } catch { /* skip */ }
  }

  // Deduplicate
  const seen = new Set<string>();
  let facts = allFacts.filter(f => {
    const id = f.entityId || "";
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Filter by domain if specified
  if (domain) {
    facts = facts.filter(f => f.domain === domain);
  }

  return JSON.stringify({
    format: "sinain-knowledge-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    domain: domain || "all",
    count: facts.length,
    facts: facts.slice(0, max),
  }, null, 2);
}

/** Import knowledge facts from a portable JSON module into the local graph. */
async function importKnowledgeToLocal(data: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { mkdirSync } = await import("node:fs");

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return JSON.stringify({ ok: false, error: "Invalid JSON" });
  }

  const facts = parsed.facts || (Array.isArray(parsed) ? parsed : null);
  if (!facts || !Array.isArray(facts) || facts.length === 0) {
    const keys = Object.keys(parsed).join(", ");
    return JSON.stringify({ ok: false, error: `No 'facts' array found. Expected sinain knowledge export format: {"facts":[...]}. Got keys: ${keys}` });
  }

  const localDir = resolveLocalMemoryDir();
  mkdirSync(localDir, { recursive: true });
  const dbPath = `${localDir}/knowledge-graph.db`;

  const __dir = dirname(fileURLToPath(import.meta.url));
  // Two package layouts are supported:
  //   dev/monorepo: <repo>/sinain-core/src/ → ../../sinain-hud-plugin/sinain-memory
  //   npm-published flat: <pkg>/sinain-core/src/ → ../../sinain-memory
  const scriptsDir = [
    resolve(__dir, "..", "..", "sinain-hud-plugin", "sinain-memory"),  // dev/monorepo layout
    resolve(__dir, "..", "..", "sinain-memory"),                         // npm-published flat layout
    resolve(__dir, "..", "sinain-memory"),                               // legacy alt
  ].find(p => existsSync(`${p}/triplestore.py`)) || resolve(__dir, "..", "..", "sinain-memory");

  // Convert facts to graph ops for knowledge_integrator
  const graphOps = facts.map((f: any) => ({
    op: "assert",
    entity: f.entity || f.entityId?.replace(/^fact:/, "").replace(/-[a-f0-9]{12}$/, "") || "unknown",
    attribute: f.attribute || "value",
    value: f.value || "",
    confidence: parseFloat(f.confidence || "0.7"),
    domain: f.domain || "",
  }));

  try {
    // SECURITY: the fact payload arrives via stdin (untrusted, parsed as JSON
    // data). The program text is a fixed constant; scriptsDir/dbPath/timestamp
    // are passed as argv (sys.argv[1..3]) so nothing dynamic is parsed as code.
    const nowIso = new Date().toISOString();
    const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from triplestore import TripleStore
from knowledge_integrator import _extract_tags
import hashlib

db_path = sys.argv[2]
now_iso = sys.argv[3]
store = TripleStore(db_path)
ops = json.loads(sys.stdin.read())
stats = {"asserted": 0, "skipped": 0}

for op in ops:
    entity = op.get("entity", "")
    value = op.get("value", "")
    if not entity or not value:
        stats["skipped"] += 1
        continue

    h = hashlib.sha256(f"{entity}:{op.get('attribute','')}:{value}".encode()).hexdigest()[:12]
    slug = entity.replace(" ", "-").lower()[:30]
    entity_id = f"fact:{slug}-{h}"

    # Check if already exists
    existing = store.entity(entity_id)
    if existing:
        stats["skipped"] += 1
        continue

    tx = store.begin_tx("import", metadata=json.dumps({"source": "web-import"}))
    store.assert_triple(tx, entity_id, "entity", entity)
    store.assert_triple(tx, entity_id, "attribute", op.get("attribute", "value"))
    store.assert_triple(tx, entity_id, "value", value)
    store.assert_triple(tx, entity_id, "confidence", str(op.get("confidence", 0.7)))
    store.assert_triple(tx, entity_id, "first_seen", now_iso)
    store.assert_triple(tx, entity_id, "last_reinforced", now_iso)
    store.assert_triple(tx, entity_id, "reinforce_count", "1")
    if op.get("domain"):
        store.assert_triple(tx, entity_id, "domain", op["domain"])
    # Tags make the fact findable: /knowledge/facts retrieval is tag-based,
    # so a fact without tag triples is write-only. Same extractor the
    # integrator uses, plus the entity name and domain themselves.
    tags = set(_extract_tags(value))
    tags.add(entity.lower().replace(" ", "-"))
    if op.get("domain"):
        tags.add(str(op["domain"]).lower())
    for tag in tags:
        store.assert_triple(tx, entity_id, "tag", tag)
    stats["asserted"] += 1

store.close()
print(json.dumps(stats))
`;

    const result = execFileSync(
      PYTHON_BIN,
      ["-c", script, scriptsDir, dbPath, nowIso],
      {
        input: JSON.stringify(graphOps),
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    const stats = JSON.parse(result.trim());
    return JSON.stringify({ ok: true, stats, imported: stats.asserted, skipped: stats.skipped });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: err.message?.slice(0, 200) });
  }
}

async function main() {
  log(TAG, "sinain-core starting...");
  // Version banner: core package version + (DMG installs) bundle identifiers
  // exported by launch-backend.sh. Source runs show "source".
  try {
    const pkg = JSON.parse(readFileSync(resolve(MODULE_DIR, "..", "package.json"), "utf-8"));
    const dmgV = process.env.SINAIN_DMG_VERSION || "source";
    const buildId = process.env.SINAIN_BUILD_ID || "source";
    log(TAG, `versions: core=${pkg.version} dmg=${dmgV} build=${buildId} node=${process.version}`);
  } catch { /* version banner is best-effort */ }

  // ── Load config ──
  const config = loadConfig();
  log(TAG, `port: ${config.port}`);
  log(TAG, `audio: device=${config.audioConfig.device} cmd=${config.audioConfig.captureCommand} chunk=${config.audioConfig.chunkDurationMs}ms`);
  log(TAG, `mic: enabled=${config.micEnabled} device=${config.micConfig.device} cmd=${config.micConfig.captureCommand}`);
  log(TAG, `transcription: model=${config.transcriptionConfig.geminiModel}`);
  log(TAG, `agent: model=${config.agentConfig.model} debounce=${config.agentConfig.debounceMs}ms max=${config.agentConfig.maxIntervalMs}ms`);
  log(TAG, `escalation: mode=${config.escalationConfig.mode} cooldown=${config.escalationConfig.cooldownMs}ms stale=${config.escalationConfig.staleMs}ms`);
  if (config.escalationConfig.staleMs > 0) {
    warn(TAG, `idle messages ON (ESCALATION_STALE_MS=${config.escalationConfig.staleMs}) — proactive chat turns on silence CONSUME API TOKENS each tick; set ESCALATION_STALE_MS=0 to disable`);
  }
  log(TAG, `openclaw: ws=${config.openclawConfig.gatewayWsUrl} http=${config.openclawConfig.hookUrl}`);
  log(TAG, `situation: ${config.situationMdPath}`);
  log(TAG, `tracing: enabled=${config.traceEnabled} dir=${config.traceDir}`);
  log(TAG, `learning: enabled=${config.learningConfig.enabled} dir=${config.learningConfig.feedbackDir}`);

  // ── Initialize privacy ──
  initPrivacy(config.privacyConfig);
  log(TAG, `privacy: mode=${config.privacyConfig.mode}`);

  // ── Initialize core buffers (single source of truth) ──
  const feedBuffer = new FeedBuffer(100);
  const senseBuffer = new SenseBuffer(30);

  // ── Initialize overlay WS handler ──
  const wsHandler = new WsHandler();

  // ── Initialize cost tracker ──
  const costTracker = new CostTracker((snapshot) => wsHandler.broadcastCost(snapshot, config.costDisplayEnabled));
  costTracker.startPeriodicLog(60_000);
  // Record a chat-sidecar turn's usage (OpenHands metrics; cost 0 for local
  // models, tokens always present) into the same tracker as analyzer/vision.
  const recordChatUsage = (u: { cost: number; tokensIn: number; tokensOut: number; model: string }): void => {
    costTracker.record({
      source: "chat", model: u.model || "sinain-chat",
      cost: u.cost || 0, tokensIn: u.tokensIn || 0, tokensOut: u.tokensOut || 0, ts: Date.now(),
    });
  };

  // ── Initialize tracing ──
  const tracer = config.traceEnabled ? new Tracer() : null;
  const traceStore = config.traceEnabled ? new TraceStore(config.traceDir) : null;

  // ── Initialize recorder ──
  const recorder = new Recorder();

  // ── Initialize profiler ──
  const profiler = new Profiler();

  // ── Initialize learning subsystem ──
  const feedbackStore = config.learningConfig.enabled
    ? new FeedbackStore(config.learningConfig.feedbackDir, config.learningConfig.retentionDays)
    : null;

  // ── Initialize embedding service (non-blocking) ──
  embeddingService = new EmbeddingService();
  embeddingService.loadAsync(); // ~9s background load, server starts immediately

  // ── Initialize web.db (UI metadata: bookmarks, page cache, retraction undo) ──
  const webDb = new WebDb(`${resolveLocalMemoryDir()}/web.db`);
  // Periodic prune of expired retraction undo tokens (10-min TTL).
  setInterval(() => {
    const pruned = webDb.pruneExpiredUndos();
    if (pruned > 0) log(TAG, `web.db: pruned ${pruned} expired undo tokens`);
  }, 5 * 60 * 1000);

  // ── Initialize local knowledge pipeline ──
  // Pass wsHandler.broadcast so the periodic curator (insight_synthesizer)
  // can push suggestions/insights directly to HUD without going through the
  // bare-agent heartbeat. Replaces the old sinain_post_feed MCP roundtrip.
  const localCuration = new LocalCurationService(
    (text) => wsHandler.broadcast(text),
  );
  // NB: pending-session distillation is triggered later, AFTER the HTTP server
  // is listening (see end of main()). runDistillation() uses execFileSync (the
  // f-coref model load alone can take ~8s), which blocks the event loop — doing
  // it here raced server.start() and could starve /health past start.sh's 15s
  // gate. It carries no time pressure, so it waits until health is answerable.

  // ── Entity subscription cache ���─
  // Detects entity mentions in transcription, prefetches knowledge facts async.
  // By the time the agent loop runs (3s debounce), cache is warm.
  const { EntityCache } = await import("./learning/entity-cache.js");
  const entityCache = new EntityCache(queryKnowledgeFactsMulti);
  entityCache.loadEntityNames().catch(() => {});
  localCuration.startPeriodicCuration();

  // Wire incremental distillation: when feed buffer fills, distill before items are lost
  localCuration.setSenseBuffer(senseBuffer);
  localCuration.setRearmCallback(() => feedBuffer.rearmOnFull());
  feedBuffer.onFull((items) => {
    localCuration.distillIncremental(items);
  });

  // ── Initialize escalation ──
  // getEscalationAgent reads bareAgentState (declared later in this function)
  // via closure at call-time, NOT at construction time. Safe because
  // dispatchSpawnTask only fires after an overlay message, which can't
  // happen before server setup completes.
  // Load agents.json once for lookup helpers passed to escalator. Same file
  // config.ts reads at startup; re-loading here keeps the dispatch lookup
  // contained to a closure (no need to expose agentsCfg through CoreConfig).
  const escalatorAgentsCfg = loadAgentsConfig();

  // Idle/ambient messages: opt-in, default OFF, persisted across restarts.
  // Decoupled from escalation mode + agent selection so it can never be
  // turned on as a side effect (the long-standing "idle keeps popping to ON"
  // bug). Only the overlay's explicit On/Off toggle (set_idle_messages_enabled)
  // changes it.
  let idleMessagesEnabled = loadUiPrefs().idleMessagesEnabled;

  const escalator = new Escalator({
    feedBuffer,
    wsHandler,
    escalationConfig: config.escalationConfig,
    openclawConfig: config.openclawConfig,
    profiler,
    feedbackStore: feedbackStore ?? undefined,
    queryKnowledgeFacts: queryKnowledgeFactsMulti,
    getEscalationAgent: () => bareAgentState.escalationAgent,
    // Type-based gateway lookup. Routing key is agents.json `profiles[name].type`,
    // so any custom profile with `type: "openclaw"` (e.g. "nemoclaw",
    // "nanoclaw-prod") gets WS dispatch automatically — no name-matching.
    isGatewayAgent: (name: string) => isGatewayProfile(escalatorAgentsCfg, name),
    // Resident chat lane (built-in sinain sidecar): no bare agent polls, so the
    // escalator delivers idle/ambient escalations in-process via ChatService.
    // (chatService is constructed just below; referenced lazily at call time.)
    isResidentAgent: (name: string) => isSinainProfile(escalatorAgentsCfg, name),
    runResidentChat: (message: string) => chatService.handle(message, { kind: "main", source: "escalation" }, { onUsage: recordChatUsage }),
    isIdleMessagesEnabled: () => idleMessagesEnabled,
  });

  // Seed the broadcast state so a late-joining overlay reflects the persisted
  // idle-messages choice on connect (the in-memory default is "off").
  wsHandler.updateState({ idleMessages: idleMessagesEnabled ? "on" : "off" });

  // ── Chat sidecar (type "sinain" roster profile) ──
  // Resident OpenHands chat agent on a local WS. When the selected escalation-lane
  // agent is type "sinain", chat turns route here instead of the run.sh/gateway path.
  const chatSidecarUrl = process.env.SINAIN_CHAT_WS_URL || "ws://127.0.0.1:9610";
  const chatService = new ChatService(chatSidecarUrl);

  // Chat sidecar liveness. The HUD talks only to core, so core polls :9610 and
  // broadcasts whether the resident chat lane is actually reachable — the
  // overlay uses this to show "Chat sidecar not running" + a Run-to-restart
  // instead of silently assuming a selected sinain lane is up.
  const chatSidecarPort = (() => {
    try { return Number(new URL(chatSidecarUrl).port) || 9610; } catch { return 9610; }
  })();
  let chatSidecarProc: ReturnType<typeof spawn> | null = null;

  // ── Warm KG retrieval daemon (kg_daemon.py) ──
  // Holds the Oxigraph stores + FTS resident read-only and serves lean ROI
  // candidates over KG_SOCK, so queryKnowledgeFactsMulti is ~0.3-0.7s instead
  // of a ~5-10s cold graph_query.py spawn. If it's down, that function falls
  // back to the spawn transparently — so this is pure acceleration.
  let kgDaemonProc: ReturnType<typeof spawn> | null = null;
  function startKgDaemon(): void {
    if (kgDaemonProc && !kgDaemonProc.killed && kgDaemonProc.exitCode === null) return;
    const script = resolveSinainMemoryScript("kg_daemon.py");
    if (!existsSync(script)) {
      warn(TAG, "kg_daemon.py not found — KG retrieval uses one-shot spawn");
      return;
    }
    log(TAG, `starting KG daemon: ${PYTHON_BIN} ${script}`);
    const child = spawn(PYTHON_BIN, [script], {
      cwd: dirname(script), env: process.env,
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    kgDaemonProc = child;
    pipeLocalAgentOutput(child.stdout, (line) => log("kg", line));
    pipeLocalAgentOutput(child.stderr, (line) => warn("kg", line));
    child.once("exit", (code) => {
      warn(TAG, `KG daemon exited (${code}); KG retrieval falls back to one-shot spawn`);
      kgDaemonProc = null;
    });
    child.once("error", (err) => warn(TAG, `KG daemon failed to start: ${err.message}`));
  }

  function probeChatSidecar(): Promise<boolean> {
    return new Promise((res) => {
      const sock = netConnect({ host: "127.0.0.1", port: chatSidecarPort });
      let settled = false;
      const done = (up: boolean) => {
        if (settled) return; settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        res(up);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(1500, () => done(false));
    });
  }

  // (Re)start the sidecar on demand — only when it's actually down, so we never
  // double-bind against the launcher's instance. Used by the overlay Run button
  // when the resident chat lane is selected but unreachable.
  function restartChatSidecar(): { ok: boolean; error?: string } {
    if (chatSidecarProc && !chatSidecarProc.killed && chatSidecarProc.exitCode === null) {
      return { ok: true };
    }
    const sidecar = resolveChatSidecar();
    if (!sidecar) return { ok: false, error: "chat sidecar not found" };
    const sidecarDir = dirname(sidecar);
    // Prefer the sidecar's own .venv (dev); fall back to system python3 (prod,
    // where the launcher pip-installs deps into the system interpreter).
    const venvPy = resolve(sidecarDir, ".venv", "bin", "python");
    // Prod fallback prefers the sinain-chat shim (a sinain-named symlink the
    // launcher creates) so the sidecar shows as "sinain-chat", not bare "Python".
    const py = existsSync(venvPy)
      ? venvPy
      : (process.env.SINAIN_CHAT_PYTHON || "python3");
    log(TAG, `restarting chat sidecar: ${py} ${sidecar}`);
    const child = spawn(py, ["sidecar.py"], {
      cwd: sidecarDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    chatSidecarProc = child;
    pipeLocalAgentOutput(child.stdout, (line) => log("chat", line));
    pipeLocalAgentOutput(child.stderr, (line) => warn("chat", line));
    child.once("error", (err) => {
      warn(TAG, `chat sidecar failed to start: ${err.message}`);
      wsHandler.broadcast(`⚠ sinain-chat failed to start: ${err.message.slice(0, 120)}`, "high");
    });
    return { ok: true };
  }

  // Poll liveness; broadcast on change. Cheap TCP probe every 5s. NOTE: the
  // timer is started later (after bareAgentState is declared) — see below.
  const probeChatLoop = async (): Promise<void> => {
    const up = await probeChatSidecar();
    if (up !== bareAgentState.chatSidecarUp) {
      bareAgentState.chatSidecarUp = up;
      wsHandler.updateState({ agents: { ...bareAgentState } });
    }
  };

  // ── Region tracker (Grammarly mode) ──
  // Ingests LLM-detected regions every tick, resolves bboxes from sense
  // events, broadcasts the set to the overlay when it changes.
  const regionTracker = new RegionTracker({
    // Off-screen eyes older than this aren't optimistically flashed back on
    // app re-entry (their anchored content is stale) — the analyzer re-detects
    // live ones fresh. Restored eyes come back DIMMED/pending and the sense
    // path re-anchors or drops them within ~2s, so a generous window trades a
    // briefly-stale eye for an instant mount on app switch (the common "slow to
    // detect after switching back" case) instead of a blank wait. Tunable.
    restoreMaxAgeMs: Number(process.env.REGION_RESTORE_MAX_AGE_MS) || 180_000,
  });
  // Frontmost app last seen on the sense path — drives instant ROI restore +
  // urgent re-analysis the moment the user switches apps (region snappiness).
  let lastFocusedApp = "";
  // Region ids whose per-ROI agent thread already got the full region
  // context (first message); follow-ups send just the user's text.
  const startedRegionThreads = new Set<string>();
  // MAIN forks: thread id → seed (MAIN transcript + digest at fork time).
  // Consumed by the thread's first chat message and by terminal seeding.
  const forkSeeds = new Map<string, string>();
  // Thread handoff transcripts: thread key (regionId, or "main") → the prior
  // conversation, sent by the overlay when the user continues a thread in
  // another agent ("Include full transcript"). One-shot: taken (and cleared)
  // by the next seed build for that thread so the destination agent picks up
  // where the chat left off, then it doesn't leak into later turns.
  const handoffContexts = new Map<string, string>();
  // Per-thread chat-agent override: thread key (regionId, or "main") → agent
  // name. A thread handoff sets this so THAT thread's chat turns route to the
  // chosen agent (resident sinain / Claude Desktop / ChatGPT / bare) WITHOUT
  // changing the global chat lane — other threads and ambient escalations keep
  // the default. Absent/"" → fall back to the global lane.
  const threadChatAgents = new Map<string, string>();
  const chatAgentFor = (key: string): string =>
    threadChatAgents.get(key) || bareAgentState.escalationAgent;
  function takeHandoffBlock(key: string): string {
    const transcript = handoffContexts.get(key);
    if (!transcript) return "";
    handoffContexts.delete(key);
    return (
      "## Continued from Sinain chat\n" +
      "The user is continuing an existing Sinain conversation here. " +
      "Briefly acknowledge that you've loaded the prior context, then pick up " +
      "where it left off.\n\n" +
      "### Conversation so far\n" +
      transcript.trim() +
      "\n\n---\n\n"
    );
  }

  // Shared region sink — RegionTracker.update + broadcast on change. Fed by
  // BOTH the cloud analyzer (loop.onRegions) and the Tier-0 SLM detector.
  const pushRegions = (regions: RawRegion[] | undefined, ctx: ContextWindow): void => {
    const changed = regionTracker.update(regions, ctx);
    if (changed) {
      // Warm KG enrichment for the visible ROIs the instant they're detected so
      // engaging one is instant. Deduped by content (roiKnowledgeKey), so the
      // frequent position-only re-anchor broadcasts hit the cache, not the KG.
      for (const r of changed) {
        const full = regionTracker.get((r as { id?: string }).id ?? "");
        if (full) void buildRoiKnowledgeCached(full as { issue: string; sourceOcr?: string; app?: string });
      }
      wsHandler.broadcastRaw({ type: "region_highlight", regions: changed, ts: Date.now() });
    }
  };

  // Tier-0 local-SLM region lane (experiment). Owns ROI detection when enabled,
  // running on its own fast, screen-change-driven cadence; the cloud loop then
  // yields regions to it (see onRegions below) and keeps only hud/digest.
  const regionDetector = new RegionDetector({
    feedBuffer,
    senseBuffer,
    config: config.regionSlmConfig,
    maxAgeMs: config.agentConfig.maxAgeMs,
    isEnabled: () => config.agentConfig.regionsEnabled && config.regionSlmConfig.enabled,
    onRegions: pushRegions,
  });
  if (config.regionSlmConfig.enabled) {
    log(TAG, `region-slm lane ON: model=${config.regionSlmConfig.model} debounce=${config.regionSlmConfig.debounceMs}ms endpoint=${config.regionSlmConfig.endpoint}`);
  }

  // ── Initialize agent loop (event-driven) ──
  const agentLoop = new AgentLoop({
    feedBuffer,
    senseBuffer,
    agentConfig: config.agentConfig,
    escalationMode: config.escalationConfig.mode,
    situationMdPath: config.situationMdPath,
    getRecorderStatus: () => recorder.getStatus(),
    profiler,
    onAnalysis: (entry, contextWindow) => {
      // Handle recorder commands
      const stopResult = recorder.handleCommand(entry.record);

      // Escalation continues as normal
      escalator.onAgentAnalysis(entry, contextWindow);
    },
    onSituationUpdate: (content) => {
      escalator.pushSituationMd(content);
    },
    onRegions: (regions, contextWindow) => {
      // Two-tier: the main analyzer emits QUALITY regions that upgrade the SLM
      // lane's provisional placeholders in place (same eye id via anchorText).
      // When the SLM lane is off, this is the sole (quality) region source.
      pushRegions(regions, contextWindow);
    },
    // Gate SITUATION.md writes (and the subsequent push) on a gateway lane
    // being active — see escalator.shouldDriveGateway. Users with no openclaw
    // profile, or with the profile but no lane selecting it, pay zero disk
    // I/O on every tick.
    shouldWriteSituation: () => escalator.shouldDriveGateway(),
    onHudUpdate: (text) => {
      wsHandler.broadcastRaw({ type: "thinking", active: false } as any);
      wsHandler.broadcast(text, "normal", "stream");
    },
    onTraceStart: tracer ? (tickId) => {
      const ctx = tracer.startTrace(tickId);
      // Hook trace persistence
      const origFinish = ctx.finish.bind(ctx);
      ctx.finish = (metrics) => {
        origFinish(metrics);
        const traces = tracer.getTraces(tickId - 1, 1);
        if (traces.length > 0 && traceStore) {
          traceStore.append(traces[0]);
        }
      };
      return ctx;
    } : undefined,
    getKnowledgeDocPath: () => {
      const workspace = resolveWorkspace();
      const p = `${workspace}/memory/sinain-knowledge.md`;
      try { if (existsSync(p)) return p; } catch {}
      return null;
    },
    feedbackStore: feedbackStore ?? undefined,
    costTracker,
    entityCache,
  });

  // ── Wire learning signal collector (needs agentLoop) ──
  const signalCollector = feedbackStore
    ? new SignalCollector(feedbackStore, agentLoop, senseBuffer)
    : null;
  if (signalCollector) {
    escalator.setSignalCollector(signalCollector);
  }

  // ── Platform-specific audio capture spawner ──
  let captureSpawner: CaptureSpawner;
  if (process.platform === "win32") {
    const { WindowsCaptureSpawner } = await import("./audio/capture-spawner-win.js");
    captureSpawner = new WindowsCaptureSpawner();
  } else {
    const { MacOSCaptureSpawner } = await import("./audio/capture-spawner-macos.js");
    captureSpawner = new MacOSCaptureSpawner();
  }

  // ── Initialize audio pipelines ──
  const systemAudioPipeline = new AudioPipeline(config.audioConfig, "system", captureSpawner);
  const micPipeline = config.micEnabled ? new AudioPipeline(config.micConfig, "mic", captureSpawner) : null;
  const transcription = new TranscriptionService(config.transcriptionConfig);
  systemAudioPipeline.setProfiler(profiler);
  if (micPipeline) micPipeline.setProfiler(profiler);
  transcription.setProfiler(profiler);
  transcription.setCostTracker(costTracker);

  // Wire: audio chunks → transcription (both pipelines share the same transcription service)
  systemAudioPipeline.on("chunk", (chunk) => {
    transcription.processChunk(chunk).catch((err) => {
      error(TAG, "transcription error:", err instanceof Error ? err.message : err);
    });
  });

  if (micPipeline) {
    micPipeline.on("chunk", (chunk) => {
      transcription.processChunk(chunk).catch((err) => {
        error(TAG, "mic transcription error:", err instanceof Error ? err.message : err);
      });
    });
  }

  // System audio pipeline lifecycle events
  systemAudioPipeline.on("error", (err) => {
    error(TAG, "system audio pipeline error:", err instanceof Error ? err.message : err);
    wsHandler.broadcast("\u26a0 System audio capture error. Check device settings.", "high");
  });

  systemAudioPipeline.on("started", () => {
    log(TAG, "system audio pipeline started");
    wsHandler.updateState({ audio: "active" });
  });

  systemAudioPipeline.on("stopped", () => {
    log(TAG, "system audio pipeline stopped");
    wsHandler.updateState({ audio: "muted" });
  });

  systemAudioPipeline.on("tcc-denied", () => {
    warn(TAG, "system audio permission denied; continuing with audio muted");
    wsHandler.updateState({ audio: "muted" });
    wsHandler.broadcast(
      "⚠ System audio capture needs macOS Screen Recording permission. Sinain is still running; enable permission, restart Terminal if prompted, then toggle audio again.",
      "urgent",
    );
  });

  systemAudioPipeline.on("muted", () => {
    log(TAG, "system audio muted (capture process still running)");
    wsHandler.updateState({ audio: "muted" });
  });

  systemAudioPipeline.on("unmuted", () => {
    log(TAG, "system audio unmuted");
    wsHandler.updateState({ audio: "active" });
  });

  // Mic pipeline lifecycle events
  if (micPipeline) {
    micPipeline.on("error", (err) => {
      error(TAG, "mic pipeline error:", err instanceof Error ? err.message : err);
      wsHandler.broadcast("\u26a0 Mic capture error. Check device settings.", "high");
    });

    micPipeline.on("started", () => {
      log(TAG, "mic pipeline started");
      wsHandler.updateState({ mic: "active" });
    });

    micPipeline.on("stopped", () => {
      log(TAG, "mic pipeline stopped");
      wsHandler.updateState({ mic: "muted" });
    });
  }

  // Wire: transcripts → feed buffer + overlay + agent trigger + recorder
  // Per-source dedup: track last 3 transcripts per source
  const recentSystemTranscripts: string[] = [];
  const recentMicTranscripts: string[] = [];

  transcription.on("transcript", (result) => {
    const isSystem = result.audioSource === "system";
    const recentSame = isSystem ? recentSystemTranscripts : recentMicTranscripts;

    // Skip near-duplicate transcripts within same source
    if (isDuplicateTranscript(result.text, recentSame)) {
      log(TAG, `transcript deduped (${result.audioSource}): "${result.text.slice(0, 60)}..."`);
      return;
    }

    // Cross-stream dedup: drop mic transcript if >70% similar to recent system transcript
    if (!isSystem && recentSystemTranscripts.length > 0) {
      const trimmed = result.text.trim();
      for (const recent of recentSystemTranscripts) {
        if (bigramSimilarity(trimmed, recent) > 0.70) {
          log(TAG, `mic transcript cross-deduped (speakers pickup): "${trimmed.slice(0, 60)}..."`);
          return;
        }
      }
    }

    // Track recent transcripts (ring buffer of 3 per source)
    recentSame.push(result.text.trim());
    if (recentSame.length > 3) recentSame.shift();

    const emoji = isSystem ? "\ud83d\udd0a" : "\ud83c\udf99";
    const tag = `[${emoji}]`;
    const bufferLevel = levelFor("audio_transcript", "local_buffer");
    const bufferText = applyLevel(result.text, bufferLevel, "audio");
    const item = feedBuffer.push(`${tag} ${bufferText}`, "normal", "audio", "stream");
    if (!isSystem) item.audioSource = "mic";
    wsHandler.broadcast(`${tag} ${bufferText}`, "normal");
    recorder.onFeedItem(item); // Collect for recording if active

    // Entity subscription: detect mentions and prefetch knowledge (async, non-blocking)
    const detectedEntities = entityCache.detectEntities(result.text);
    if (detectedEntities.length > 0) entityCache.prefetch(detectedEntities);

    agentLoop.onNewContext(); // Trigger debounced analysis
  });

  // ── Screen capture active flag ──
  let screenActive = true;

  // ── Escalation pause/resume state ──
  let savedEscalationMode: typeof config.escalationConfig.mode | null = null;

  /** Pause escalation (idempotent). Caches the pre-pause mode so resume
   *  can restore it. Re-entering while already paused is a no-op — crucially,
   *  does NOT overwrite savedEscalationMode with "off". */
  function pauseEscalationInternal(): void {
    const current = config.escalationConfig.mode;
    if (current === "off") return;
    savedEscalationMode = current;
    escalator.setMode("off");
    log(TAG, `escalation paused (was: ${savedEscalationMode})`);
  }

  /** Resume escalation (idempotent). Restores the saved mode or falls back
   *  to "rich" if no saved mode exists. Re-entering while already active
   *  is a no-op. */
  function resumeEscalationInternal(): void {
    const current = config.escalationConfig.mode;
    if (current !== "off") return;
    const mode = savedEscalationMode ?? "rich";
    savedEscalationMode = null;
    escalator.setMode(mode);
    log(TAG, `escalation resumed (mode: ${mode})`);
  }

  // ── Bare-agent roster & per-lane current agent ──
  // In-memory only (matches escalation-mode lifecycle). Populated when the
  // bare agent POSTs /bareagent/register on startup; mutated by set_agent
  // command from the overlay. Empty-string lane values = "Off" (disabled).
  // Profile names from agents.json may be custom (e.g. "pclaude",
  // "openclaude-spawn"), so the server validates by character class
  // rather than a fixed whitelist. The bare agent owns the source of
  // truth for which profiles actually exist on its host. The validator
  // just rejects names that could break shell logging, paths, or be
  // injection vectors.
  const AGENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
  // "openclaw" is reserved-injected below when gatewayWsUrl is set —
  // it's not a local CLI, it's a routing choice that sends tasks to the
  // remote OpenClaw gateway via WS RPC instead of the local bare agent.
  // Two selectors only: chat (escalation) + terminal. The spawn lane was
  // removed — region/thread tasks run on the chat lane, never a spawn lane.
  const bareAgentState: {
    /** Chat-lane roster: conversational agents only (sinain sidecar, desktop
     *  chat apps, gateways). CLI agents are terminal-only — excluded here. */
    available: string[];
    /** Terminal-lane roster: CLI binaries only; sinain/desktop/gateway excluded. */
    terminalAvailable: string[];
    escalationAgent: string;
    /** Interactive terminal lane — decoupled from escalation, excludes sinain. */
    terminalAgent: string;
    /** True when the chat lane is the resident sinain sidecar (liveness = the
     *  sidecar WS, not bare-agent registration). Kept in sync wherever
     *  escalationAgent changes so the overlay never demands a terminal for it. */
    escalationResident: boolean;
    /** True when the chat lane is a desktop app (Claude Desktop / ChatGPT) —
     *  chat opens the external app, so the overlay must not open its own HUD
     *  chat surface for region/manual-ROI chats. */
    escalationDesktop: boolean;
    /** True when the resident chat sidecar (:9610) is actually reachable.
     *  Polled by core; lets the overlay distinguish "built-in chat connected"
     *  from "selected sinain but the sidecar is down" (→ warning + Run). */
    chatSidecarUp: boolean;
    registered: boolean;
  } = { available: [], terminalAvailable: [], escalationAgent: "", terminalAgent: "", escalationResident: false, escalationDesktop: false, chatSidecarUp: false, registered: false };
  let localAgentProcess: ReturnType<typeof spawn> | null = null;
  let localAgentName = "";

  // ── Service guard ── liveness/freshness of each stack service, surfaced in
  // /health and broadcast to the overlay (banner) so a dead/stale service is
  // VISIBLE instead of silently serving stale data (e.g. a stuck screen
  // pipeline feeding 6-hour-old OCR into a seed). State per service:
  //   live  — healthy / fresh
  //   stale — running but data is old (sense frames not arriving)
  //   down  — expected but unreachable (sidecar/runner needed yet absent)
  //   off   — not in use (no warning) — e.g. screen toggled off, lane not selected
  const SENSE_STALE_MS = 60_000;
  let lastSenseAt = 0;
  function serviceStatuses(): Array<{ name: string; label: string; state: string; detail?: string }> {
    const now = Date.now();
    const senseAge = lastSenseAt ? now - lastSenseAt : Infinity;
    const senseState = !screenActive
      ? "off"
      : lastSenseAt === 0 ? "down" : senseAge > SENSE_STALE_MS ? "stale" : "live";
    // sinain-chat (resident chat sidecar) only matters when it's the chat lane.
    const chatState = !bareAgentState.escalationResident
      ? "off" : bareAgentState.chatSidecarUp ? "live" : "down";
    // The agent runner (run.sh) only matters when a bare-agent lane is selected.
    const usingBare = !!bareAgentState.escalationAgent
      && !bareAgentState.escalationResident && !bareAgentState.escalationDesktop;
    const runnerState = !usingBare ? "off" : bareAgentState.registered ? "live" : "down";
    return [
      { name: "backend", label: "Backend", state: "live" },
      { name: "sense", label: "Screen capture", state: senseState,
        detail: lastSenseAt ? `${Math.round(senseAge / 1000)}s ago` : "no frames" },
      { name: "sinain-chat", label: "sinain-chat", state: chatState },
      { name: "agent-runner", label: "Agent Runner", state: runnerState },
    ];
  }
  let shuttingDown = false;
  // ChatGPT "network harness" gate — exposes the local MCP server over a public
  // tunnel, so it's a security-sensitive opt-in. Runtime-toggled from the
  // overlay settings (set_chatgpt_harness); seeded from the env for headless.
  let chatgptHarnessEnabled = process.env.SINAIN_ENABLE_CHATGPT_DESKTOP === "true";
  // Brings the public MCP tunnel up/down with the harness toggle (spawns the
  // HTTP MCP transport + frpc, runs the device-signed /pair, surfaces the
  // connector URL + pairing code to the overlay). See mcp-tunnel/controller.ts.
  const tunnelController = new TunnelController({
    packageRoot: PACKAGE_ROOT,
    corePort: config.port,
    workspace: resolveWorkspace(),
    onState: (s) => wsHandler.updateTunnel(s),
  });
  if (chatgptHarnessEnabled) void tunnelController.start(); // env-seeded headless

  function registerBareAgent(availableList: string[], current: string, registered = true): void {
    const clean = availableList.filter((a) => typeof a === "string" && AGENT_NAME_RE.test(a));
    // Inject every gateway-style profile (any agents.json profile with
    // `type: "openclaw"`) into the roster — they have no local binary, so
    // run.sh's PATH filter drops them, but sinain-core knows they exist
    // and routes them via WS RPC.
    //
    // This generalizes the legacy "auto-inject the literal name 'openclaw'"
    // behavior: now custom gateway profiles like "nemoclaw" or
    // "nanoclaw-prod" appear in the overlay roster automatically as soon
    // as you add them to agents.json. The single WS client uses the first
    // gateway profile's connection params (config.ts findGatewayProfile);
    // simultaneous multi-gateway is a follow-up.
    if (config.openclawConfig.gatewayWsUrl) {
      for (const gwName of gatewayProfileNames(escalatorAgentsCfg)) {
        if (!clean.includes(gwName)) clean.push(gwName);
      }
      // Legacy fallback: if no gateway profiles are defined in agents.json
      // but gatewayWsUrl is set via env, still inject the canonical name.
      if (clean.filter((n) => isGatewayProfile(escalatorAgentsCfg, n)).length === 0
          && !clean.includes("openclaw")) {
        clean.push("openclaw");
      }
    }
    // Inject sinain-typed (resident chat sidecar) profiles into the CHAT roster.
    // Like gateway profiles they have no PATH binary, so run.sh's roster POST
    // drops them — but the chat lane routes them in-process via ChatService, so
    // sinain-core must surface them itself. (They stay OUT of terminalRoster
    // below: the sidecar has no interactive TUI.)
    for (const snName of sinainProfileNames(escalatorAgentsCfg)) {
      if (!clean.includes(snName)) clean.push(snName);
    }
    // Gate desktop chat-app profiles (Claude/ChatGPT) for the CHAT roster:
    // offer one ONLY if the app is installed — never an app the user lacks.
    // ChatGPT additionally needs the remote-MCP connector (tunnel), so it's
    // behind a feature flag, OFF by default. Applied as a FILTER (not just an
    // inject-guard) because desktop names can arrive via the agents.json
    // pre-populate too — we must drop failing ones, not only skip adding them.
    // Like sinain profiles they're chat-only (no TUI; excluded from terminal).
    const chatgptEnabled = chatgptHarnessEnabled;
    const desktopOk = (name: string): boolean => {
      const t = desktopProfileType(escalatorAgentsCfg, name);
      if (!t) return true; // not a desktop profile — unaffected
      if (t === "chatgpt_desktop" && !chatgptEnabled) return false;
      return desktopAppInstalled(t);
    };
    for (let k = clean.length - 1; k >= 0; k--) {
      if (isDesktopProfile(escalatorAgentsCfg, clean[k]) && !desktopOk(clean[k])) clean.splice(k, 1);
    }
    for (const dName of desktopProfileNames(escalatorAgentsCfg)) {
      if (desktopOk(dName) && !clean.includes(dName)) clean.push(dName);
    }
    bareAgentState.registered = registered;
    // Two disjoint rosters by agent kind:
    //  • CHAT lane — conversational agents only: the resident sinain sidecar,
    //    desktop chat apps (Claude/ChatGPT), and gateway profiles. CLI agents
    //    (claude, openclaude, codex, goose, …) are NO LONGER offered for chat —
    //    they're terminal tools and now appear ONLY in the terminal roster.
    //  • TERMINAL lane — interactive REPL agents: the CLI binaries only.
    //    sinain/desktop (no TUI) and gateways (WS-routed, no TUI) are excluded.
    // A "CLI" profile is anything that isn't sinain-, desktop-, or gateway-typed
    // (i.e. a PATH binary run.sh dispatches as a subprocess).
    const isCliProfile = (a: string): boolean =>
      !isSinainProfile(escalatorAgentsCfg, a)
      && !isDesktopProfile(escalatorAgentsCfg, a)
      && !isGatewayProfile(escalatorAgentsCfg, a);
    const chatRoster = clean.filter((a) => !isCliProfile(a));
    // Terminal is CLI-only: gateways are chat-routed (WS RPC) with no TUI, so
    // selecting one for the terminal would only trip run.sh's auto-substitution
    // warning. They live in the chat roster above, never here.
    const terminalRoster = clean.filter((a) => isCliProfile(a));
    bareAgentState.available = chatRoster;
    bareAgentState.terminalAvailable = terminalRoster;
    // Decoupled defaults: chat lane prefers `default` (sinain), then a
    // chat-eligible `current`, then the first chat agent; terminal lane prefers
    // `terminalDefault`, then `current`, then the first terminal-eligible one.
    const chatDefault = escalatorAgentsCfg?.default;
    const pickChat = (): string =>
      (chatDefault && chatRoster.includes(chatDefault)) ? chatDefault
      : chatRoster.includes(current) ? current
      : (chatRoster[0] ?? "");
    const terminalDefault = escalatorAgentsCfg?.terminalDefault;
    const pickTerminal = (): string =>
      (terminalDefault && terminalRoster.includes(terminalDefault)) ? terminalDefault
      : terminalRoster.includes(current) ? current
      : (terminalRoster[0] ?? "");
    // If neither lane is set yet (fresh boot), adopt the relevant default. If
    // state survives from a prior register call AND the agent still exists in
    // the lane's roster, keep it; otherwise fall back.
    if (!bareAgentState.escalationAgent || !chatRoster.includes(bareAgentState.escalationAgent)) {
      bareAgentState.escalationAgent = pickChat();
    }
    if (!bareAgentState.terminalAgent || !terminalRoster.includes(bareAgentState.terminalAgent)) {
      bareAgentState.terminalAgent = pickTerminal();
    }
    bareAgentState.escalationResident = isSinainProfile(escalatorAgentsCfg, bareAgentState.escalationAgent);
    bareAgentState.escalationDesktop = isDesktopProfile(escalatorAgentsCfg, bareAgentState.escalationAgent);
    wsHandler.updateState({ agents: { ...bareAgentState } });
    log(TAG, `bareagent register: chat=[${chatRoster.join(",")}] terminal=[${terminalRoster.join(",")}] current=${current} → lanes esc=${bareAgentState.escalationAgent} term=${bareAgentState.terminalAgent}`);

    // Lane is the source of truth for "is escalation active?". If a lane is
    // set but mode is still "off" (e.g. an old wizard run wrote mode=off and
    // the user has since picked an agent in the chip selector — or we just
    // booted from agents.json with that combination), reconcile by promoting
    // mode to match. Mirrors the existing set_agent → resumeEscalation flow,
    // applied at register time so the boot-from-disk case isn't an exception.
    //
    // BUT `{ escalationAgent set, mode === "off" }` is ambiguous — it also
    // describes a *deliberate user pause* (idle messages → Off, or
    // set_agent("escalation","")) where an agent stays selected. Auto-resuming
    // there clobbers the user's intent, and because the bare agent
    // re-registers every few minutes the pause reverts within seconds — the
    // reported "idle messages off doesn't stick" bug. `savedEscalationMode` is
    // the discriminator: it is non-null ONLY while a user-initiated pause is
    // active (pause sets it, resume clears it); a stale/boot mode=off leaves it
    // null. So only reconcile the stale case — never override a live pause.
    if (bareAgentState.escalationAgent
        && config.escalationConfig.mode === "off"
        && savedEscalationMode === null) {
      resumeEscalationInternal();
    }
  }

  function startLocalAgent(requestedAgent?: string): {
    ok: boolean;
    agent?: string;
    alreadyRunning?: boolean;
    error?: string;
  } {
    if (localAgentProcess && !localAgentProcess.killed && localAgentProcess.exitCode === null) {
      return { ok: true, agent: localAgentName, alreadyRunning: true };
    }

    // The local runner drives the interactive TERMINAL lane — decoupled from
    // the chat/escalation lane (which may be the sinain sidecar). Default to
    // the terminal selection, then terminalDefault, then env/claude.
    const agent = (requestedAgent?.trim()
      || bareAgentState.terminalAgent
      || escalatorAgentsCfg?.terminalDefault
      || process.env.SINAIN_AGENT
      || "claude");
    if (!AGENT_NAME_RE.test(agent)) {
      return { ok: false, error: `Invalid agent name "${agent}"` };
    }
    if (isGatewayProfile(escalatorAgentsCfg, agent)) {
      return { ok: false, error: `Agent "${agent}" is a gateway profile; local runner is not needed` };
    }
    if (isSinainProfile(escalatorAgentsCfg, agent)) {
      return { ok: false, error: `Agent "${agent}" is the resident chat sidecar; it has no interactive terminal` };
    }
    if (bareAgentState.terminalAvailable.length > 0 && !bareAgentState.terminalAvailable.includes(agent)) {
      return { ok: false, error: `Agent "${agent}" not available in the terminal roster` };
    }

    const runSh = resolveLocalAgentScript();
    if (!runSh) {
      return { ok: false, error: "sinain-agent-runner/run.sh not found" };
    }

    const mcpConfigPath = writeLocalAgentMcpConfig(config.port);
    const coreUrl = process.env.SINAIN_CORE_URL || `http://localhost:${config.port}`;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MCP_CONFIG: mcpConfigPath,
      SINAIN_AGENT: agent,
      SINAIN_CORE_URL: coreUrl,
      ESCALATION_TRANSPORT: "http",
    };
    // Strip Claude Code session vars that leak in when sinain-core itself was
    // launched from inside a Claude Code / agent session. They redirect the
    // spawned CLI agents (claude, openclaude) to the parent session's config
    // dir, where their own credentials don't exist — surfacing as
    // "No cookie auth credentials found" 401s on every invocation.
    // (Profile-level CLAUDE_CODE_* overrides are unaffected: run.sh applies
    // them per profile after this spawn.)
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_CONFIG_DIR" ||
          key === "CLAUDECODE" || key === "AI_AGENT") {
        delete childEnv[key];
      }
    }
    const child = spawn("bash", [runSh], {
      cwd: dirname(runSh),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    localAgentProcess = child;
    localAgentName = agent;
    log(TAG, `local agent start requested: agent=${agent} script=${runSh} mcp=${mcpConfigPath}`);
    pipeLocalAgentOutput(child.stdout, (line) => log("agent", line));
    pipeLocalAgentOutput(child.stderr, (line) => warn("agent", line));

    child.once("error", (err) => {
      if (localAgentProcess === child) {
        localAgentProcess = null;
        localAgentName = "";
      }
      warn(TAG, `local agent failed to start: ${err.message}`);
      wsHandler.broadcast(`⚠ Local agent failed to start: ${err.message.slice(0, 120)}`, "high");
    });

    child.once("exit", (code, signal) => {
      if (localAgentProcess !== child) return;
      localAgentProcess = null;
      localAgentName = "";
      if (bareAgentState.registered) {
        bareAgentState.registered = false;
        wsHandler.updateState({ agents: { ...bareAgentState } });
      }
      const exitText = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      log(TAG, `local agent exited (${exitText})`);
      if (!shuttingDown && code !== 0) {
        wsHandler.broadcast(`⚠ Local agent exited (${exitText})`, "high");
      }
    });

    return { ok: true, agent };
  }

  // Pre-populate the roster from agents.json profiles so launchers that
  // don't run the bare-agent process (e.g. start.sh / start-local.sh) still
  // surface the user's configured profiles in the overlay's agent picker.
  // When the bare-agent IS running (npm install + cli.js start), its first
  // /bareagent/register POST narrows the list to PATH-installed binaries —
  // same final state as before, just with a usable initial state for the
  // dev-loop launcher.
  if (escalatorAgentsCfg?.profiles) {
    const profileNames = Object.keys(escalatorAgentsCfg.profiles)
      .filter((n) => AGENT_NAME_RE.test(n));
    if (profileNames.length > 0) {
      const defaultAgent = escalatorAgentsCfg.default ?? profileNames[0];
      registerBareAgent(profileNames, defaultAgent, false);
      log(TAG, `roster pre-populated from agents.json: ${profileNames.join(",")}`);
    }
  }

  // Start chat-sidecar liveness polling now that bareAgentState exists.
  const chatProbeTimer = setInterval(() => { void probeChatLoop(); }, 5000);
  void probeChatLoop();

  // Warm the KG retrieval daemon at boot (no-op if the script is missing).
  startKgDaemon();

  // ── Create HTTP + WS server ──
  const server = createAppServer({
    config,
    feedBuffer,
    senseBuffer,
    wsHandler,
    profiler,
    costTracker,
    feedbackStore: feedbackStore ?? undefined,
    webDb,
    searchEntities: (q, limit) => searchEntitiesMulti(q, limit),
    graphChildren: (entity) => graphChildrenMulti(entity),
    renderEntityPage: (entity, opts) => renderEntityPageMulti(entity, opts),
    retractFact: (factId, reason, actor, sourceEntity) =>
      retractOrRestoreFact("retract", factId, { reason, actor, sourceEntity }),
    restoreFact: (factId, undoToken) =>
      retractOrRestoreFact("restore", factId, { undoToken }),
    exportConcept: (entity, depth, opts) => exportConceptBundle(entity, depth, opts),
    importConcept: (envelope, conflict) => importConceptBundle(envelope, conflict),
    isScreenActive: () => screenActive,

    onMotion: (dx, dy, changedBoxes, app, display) => {
      if (!config.agentConfig.regionsEnabled) return;
      const moved = regionTracker.applyMotion(dx, dy, changedBoxes, app, display);
      debug("regions", `motion dx=${dx} dy=${dy} changed=${changedBoxes.length} app=${app} disp=${display} → ${moved ? moved.length + " moved" : "no eyes matched"}`);
      if (moved) {
        wsHandler.broadcastRaw({ type: "region_highlight", regions: moved, ts: Date.now() });
      }
    },
    onSenseEvent: (event: SenseEvent) => {
      // Respect toggle_screen — if user disabled screen, ignore sense events
      if (!screenActive) return;

      lastSenseAt = Date.now(); // service guard: screen pipeline is fresh
      wsHandler.updateState({ screen: "active" });

      // Track app context for recorder
      recorder.onSenseEvent(event);

      // Tier 1 \u2014 instant ROI restore on app switch: the sense path carries the
      // earliest app signal, well before the analyzer tick. The moment the
      // frontmost app changes, re-show the eyes we had archived for it (dimmed/
      // pending) straight from the archive \u2014 no LLM/OCR wait.
      const rawApp = event.meta.app || "";
      const appChanged = rawApp !== "" && rawApp !== lastFocusedApp;
      if (appChanged) {
        lastFocusedApp = rawApp;
        const restored = regionTracker.onAppFocus(rawApp);
        if (restored) {
          wsHandler.broadcastRaw({ type: "region_highlight", regions: restored, ts: Date.now() });
        }
      }

      // Large viewport change (scroll / in-app navigation): the change region
      // covers most of the frame, so eyes anchored to the old layout are now
      // stale. Flip them to pending ("rechecking" \u2014 overlay dims) so they stop
      // pointing at scrolled-away content; the urgent re-analysis below
      // re-confirms + re-anchors survivors and the pending leash drops the rest.
      // (App switches are handled by the archive/restore above, so skip those.)
      const bbox = event.imageBbox, fs = event.frameSize;
      const coverage = (bbox && bbox.length === 4 && fs && fs.length === 2 && fs[0] > 0 && fs[1] > 0)
        ? (bbox[2] * bbox[3]) / (fs[0] * fs[1]) : 0;
      const bigChange = coverage >= 0.5;
      if (bigChange && !appChanged) {
        const dimmed = regionTracker.markStaleForRecheck();
        if (dimmed) {
          wsHandler.broadcastRaw({ type: "region_highlight", regions: dimmed, ts: Date.now() });
        }
      }

      // A1+A2 — local re-anchoring (no LLM): slide live eyes to follow their
      // content on this fresh frame and dim ones whose text scrolled off, at
      // capture rate — so eyes track scroll/typing without waiting for the next
      // analyzer tick. Runs after the big-change dim so it un-dims + re-anchors
      // the eyes still present and lets the absent ones stay dimmed.
      if (config.agentConfig.regionsEnabled && event.ocrLines?.length) {
        const moved = regionTracker.reanchorLive(event);
        if (moved) {
          wsHandler.broadcastRaw({ type: "region_highlight", regions: moved, ts: Date.now() });
        }
      }

      // Broadcast app/window changes to overlay
      if (event.type === "text" && event.ocr && event.ocr.trim().length > 10) {
        const app = shortAppName(event.meta.app || "");
        const firstLine = event.ocr.split("\n").find((l: string) => l.trim().length > 5)?.trim() || event.ocr.split("\n")[0].trim();
        const text = firstLine.slice(0, 80);
        const prefix = app ? `${app}: ` : "";
        wsHandler.broadcast(`[\ud83d\udc41] ${prefix}${text}`, "normal");
      }

      // Trigger agent analysis. Tier 2 \u2014 fast re-confirm: an app switch or a
      // large viewport change goes urgent (~200ms debounce vs the full 6s) so
      // real regions re-detect fast, confirming/re-anchoring the pending eyes
      // and surfacing new ones.
      agentLoop.onNewContext(appChanged || bigChange);

      // Tier-0 SLM region lane runs on the raw screen-change cadence (no-op
      // unless REGION_SLM_ENABLED) \u2014 decoupled from the cloud loop's debounce.
      // App switch / big viewport change \u2192 urgent (skip debounce) so the new
      // screen's eyes mount the instant its OCR lands.
      regionDetector.onContextChange(appChanged || bigChange);
    },

    onFeedPost: (text: string, priority: string) => {
      const item = feedBuffer.push(text, priority as any, "system", "stream");
      wsHandler.broadcast(text, priority as any);
      agentLoop.onNewContext();
      log(TAG, `[feed] #${item.id}: ${text.slice(0, 80)}`);
    },

    onSenseProfile: (snapshot) => profiler.reportSense(snapshot),

    getThreadSession: (regionId: string) => escalator.threadSession(regionId),

    // Returns the rich ROI seed text AND stores it under an id for the unified
    // sinain_roi pull. The terminal, Claude Desktop and ChatGPT all consume the
    // SAME seed via the SAME mechanic (sinain_roi id=…); this is the one builder.
    getRegionTask: async (regionId: string) => composeAndStoreRoiSeed(regionId),

    // One-shot pending handoff transcript (MAIN terminal pulls + prepends it).
    getHandoffBlock: (key: string) => takeHandoffBlock(key),

    // Mint a seed from arbitrary text → id for the unified sinain_roi MCP pull.
    // Interactive terminals seed ALL context this way — no seed files on disk.
    mintRoiSeed: (text: string) => roiSeeds.put(text, ""),

    // Portable seed text for the clipboard "copy seed" action.
    buildSeed: (key: string, transcript?: string, focus?: string) => buildPortableSeed(key, transcript, focus),

    getHealthPayload: () => {
      const escStats = escalator.getStats();
      const warnings: string[] = [];

      // Compute health warnings from escalation metrics
      const totalAttempts = (escStats.totalDirectResponses as number) + (escStats.totalTimeouts as number);
      const timeoutRate = totalAttempts > 0 ? (escStats.totalTimeouts as number) / totalAttempts : 0;

      if (totalAttempts >= 5 && timeoutRate > 0.3) {
        warnings.push(`high_timeout_rate: ${Math.round(timeoutRate * 100)}%`);
      }
      if ((escStats.consecutiveTimeouts as number) >= 3) {
        warnings.push(`consecutive_timeouts: ${escStats.consecutiveTimeouts}`);
      }
      const lastResp = escStats.lastResponseTs as number;
      if (lastResp > 0 && Date.now() - lastResp > 5 * 60 * 1000) {
        warnings.push(`stale_responses: ${Math.round((Date.now() - lastResp) / 60000)}min`);
      }
      if ((escStats.totalSpawnResponses as number) > 5 && (escStats.totalDirectResponses as number) === 0) {
        warnings.push("no_direct_responses");
      }
      if ((escStats.avgResponseMs as number) > 30000) {
        warnings.push(`slow_responses: ${Math.round(escStats.avgResponseMs as number)}ms avg`);
      }

      return {
        warnings,
        services: serviceStatuses(),
        agent: agentLoop.getStats(),
        escalation: escStats,
        transcription: transcription.getProfilingStats(),
        situation: { path: config.situationMdPath },
        traces: tracer ? tracer.getMetricsSummary() : null,
        profiling: profiler.getSnapshot(),
      };
    },

    getAgentDigest: () => agentLoop.getDigest(),
    getAgentHistory: (limit) => agentLoop.getHistory(limit),
    getAgentContext: () => agentLoop.getContext(),
    getAgentConfig: () => agentLoop.getConfig(),

    updateAgentConfig: (updates) => {
      // Handle escalation mode updates
      if (updates.escalationMode !== undefined) {
        const mode = String(updates.escalationMode) as EscalationMode;
        if (["focus", "selective", "rich", "off"].includes(mode)) {
          escalator.setMode(mode);
          (agentLoop as any).deps.escalationMode = mode;
        }
      }
      if (updates.escalationCooldownMs !== undefined) {
        config.escalationConfig.cooldownMs = Math.max(5000, parseInt(String(updates.escalationCooldownMs)));
      }
      if (updates.escalationStaleMs !== undefined) {
        config.escalationConfig.staleMs = Math.max(0, parseInt(String(updates.escalationStaleMs)));
      }
      agentLoop.updateConfig(updates);
      return agentLoop.getConfig();
    },

    getTraces: (after, limit) => tracer ? tracer.getTraces(after, limit) : [],
    reconnectGateway: () => escalator.reconnectGateway(),

    // User command injection (bare agent / HTTP)
    setUserCommand: (text: string) => escalator.setUserCommand(text),

    // Bare agent HTTP escalation bridge
    getEscalationPending: () => escalator.getPendingHttp(),
    isEscalationPaused: () => savedEscalationMode !== null,
    respondEscalation: (id: string, response: string) => escalator.respondHttp(id, response),

    // Bare-agent roster & config (wired to server endpoints in step 2).
    registerBareAgent,
    getBareAgentConfig: () => ({
      escalationAgent: bareAgentState.escalationAgent,
      terminalAgent: bareAgentState.terminalAgent,
      registered: bareAgentState.registered,
    }),

    // Knowledge graph integration (checks both local and workspace DBs)
    getKnowledgeDocPath: () => {
      // Check local first, then workspace
      const localPath = `${resolveLocalMemoryDir()}/sinain-knowledge.md`;
      const workspacePath = `${resolveWorkspace()}/memory/sinain-knowledge.md`;
      try { if (existsSync(localPath)) return localPath; } catch {}
      try { if (existsSync(workspacePath)) return workspacePath; } catch {}
      return null;
    },
    queryKnowledgeFacts: queryKnowledgeFactsMulti,
    listKnowledgeEntities: listKnowledgeEntitiesMulti,
    queryKnowledgeAsOf: queryKnowledgeAsOfMulti,
    exportKnowledge: exportKnowledgeMulti,
    importKnowledge: importKnowledgeToLocal,

    // Spawn background agent task (from HUD Shift+Enter or bare agent POST /spawn)
    onSpawnCommand: (text: string) => {
      escalator.dispatchSpawnTask(text, "user-command").catch((err) => {
        log("srv", `spawn via HTTP failed: ${err}`);
      });
    },
    getSpawnPending: () => escalator.getSpawnPending(),
    respondSpawn: (id: string, result: string) => escalator.respondSpawn(id, result),
    embedTexts: (texts: string[]) => embeddingService!.embed(texts),
    isEmbeddingReady: () => embeddingService?.ready ?? false,
  });

  // ── Wire overlay profiling ──
  wsHandler.onProfiling((msg) => {
    profiler.reportOverlay({ rssMb: msg.rssMb, uptimeS: msg.uptimeS, ts: msg.ts });
  });

  // Route a chat turn to the resident sinain sidecar (the CHAT lane). Used by
  // BOTH the main thread and region/ROI threads so the chat selector serves
  // chat regardless of thread (per the decoupled lane model). `regionId`
  // scopes the reply to that thread; undefined = main thread.
  //
  // The sidecar is stateless per turn, so we always pass the thread's context
  // as `seed`: region task text for an ROI thread, the fork seed for a fork
  // thread, none for main (the main digest is a separate follow-up concern).
  // Conversation continuity within a thread is a later (resident-session)
  // optimization — same limitation main chat already has.
  // THE single ROI seed builder. Composes the rich seed (region issue/tip +
  // source OCR + current digest + long-term knowledge-graph facts), stores it
  // under a minted id, and returns {id, text}. Every agent surface — the
  // interactive terminal, Claude Desktop, ChatGPT — pulls this exact seed by id
  // through the sinain_roi MCP tool. One builder, one store, one pull mechanic.
  // Knowledge enrichment has a hard 1.5s budget (triplestore cold start); the
  // seed also carries MCP instructions so the agent can query more itself.
  async function composeAndStoreRoiSeed(regionId: string): Promise<{ id: string; text: string } | null> {
    const forkSeed = forkSeeds.get(regionId);
    if (forkSeed) {
      const id = roiSeeds.put(forkSeed, regionId);
      return { id, text: forkSeed };
    }
    const region = regionTracker.get(regionId);
    if (!region) return null;
    const digest = agentLoop.getDigest()?.digest;
    // Handoff transcript (if the user continued a chat thread here). Captured
    // once so both the fast seed and the async-enriched update carry it — a
    // one-shot take inside the enrichment closure would come up empty.
    const handoff = takeHandoffBlock(regionId);
    // FAST seed: region + OCR + digest, NO knowledge wait — store + return now
    // so the app (or terminal) launches instantly.
    const fastText = handoff + buildRegionTaskText(region, digest);
    const id = roiSeeds.put(fastText, regionId);
    // ASYNC enrich: run the full knowledge-graph query (no 1.5s race — it has a
    // ~5s cold start) and upgrade the stored seed in place. The agent pulls via
    // sinain_roi several seconds after launch, by which time this has usually
    // landed. Best-effort: if the pull beats it, the agent still has the fast
    // seed + can call sinain_memory_query itself.
    void (async () => {
      try {
        // Entity-path knowledge (web-UI quality, local-SLM consolidated). Reads
        // the detect-time prefetch cache — usually already warm, so this no
        // longer races the cold KG; updates the stored seed when it lands.
        const knowledge = await buildRoiKnowledgeCached(region);
        if (knowledge?.trim()) {
          roiSeeds.update(id, handoff + buildRegionTaskText(region, digest, undefined, knowledge));
        }
      } catch { /* enrichment is optional */ }
    })();
    return { id, text: fastText };
  }

  // Portable seed for the clipboard ("copy seed" — for agents we don't
  // integrate with). Builds the SAME context we feed supported agents (region
  // task text incl. MCP-tool note, or the MAIN digest), but synchronously
  // AWAITS knowledge enrichment so the pasted text is self-contained, folds in
  // the carried transcript, and prepends a readable header. key = regionId or
  // "main". Returns null when the region is unknown.
  async function buildPortableSeed(key: string, transcript?: string, focus?: string): Promise<string | null> {
    const header = "# Context from Sinain\n\n";
    const tx = transcript?.trim()
      ? `## Continued from Sinain chat\n${transcript.trim()}\n\n---\n\n`
      : "";
    // Clipboard enrichment: treat the focus text (the user's copied content) as
    // a pseudo-ROI and return the situational digest + KG retrieved against it.
    // Body only (no header) — the overlay frames it under a separator after the
    // user's own content.
    if (key === "clipboard" || (focus && focus.trim())) {
      const digest = agentLoop.getDigest()?.digest;
      let knowledge = "";
      if (focus && focus.trim()) {
        try {
          knowledge = await buildRoiKnowledge({ issue: focus.trim().slice(0, 1200), sourceOcr: "" });
        } catch { /* knowledge is optional */ }
      }
      const parts: string[] = [
        digest ? `Current situation:\n${digest}` : "(No situation digest yet.)",
      ];
      if (knowledge.trim()) parts.push(`Relevant knowledge:\n${knowledge.trim()}`);
      return parts.join("\n\n");
    }
    if (key === "main") {
      const digest = agentLoop.getDigest()?.digest;
      const body = digest ? `Current situation:\n${digest}` : "(No situation digest yet.)";
      return header + tx + body;
    }
    const region = regionTracker.get(key);
    if (!region) return null;
    const digest = agentLoop.getDigest()?.digest;
    let knowledge: string | undefined;
    try {
      // Entity-path knowledge (web-UI quality, local-SLM consolidated). Reads
      // the detect-time prefetch cache — usually warm, so the pasted seed is
      // self-contained without waiting on a cold KG query.
      const k = await buildRoiKnowledgeCached(region);
      if (k?.trim()) knowledge = k;
    } catch { /* knowledge is optional */ }
    return header + tx + buildRegionTaskText(region, digest, undefined, knowledge);
  }

  const routeSinainChat = (text: string, regionId?: string): void => {
    // A user chat/ROI turn must immediately drop ambient escalations: they
    // share this one resident sidecar, and an escalation storm (e.g. while a
    // doc is open) otherwise starves the user's turn → ChatService timeout.
    escalator.noteUserChatting();
    let seed: string | undefined;
    const kind: "main" | "roi" = regionId ? "roi" : "main";
    if (regionId) {
      const region = regionTracker.get(regionId);
      const forkSeed = forkSeeds.get(regionId);
      if (region) seed = buildRegionTaskText(region, agentLoop.getDigest()?.digest);
      else if (forkSeed) seed = forkSeed;
    }
    // Thread handoff into the resident sidecar: prepend the carried transcript
    // so the sidecar continues the prior conversation rather than cold-starting.
    const handoff = takeHandoffBlock(regionId ?? "main");
    if (handoff) seed = handoff + (seed ?? "");
    wsHandler.broadcastRaw({ type: "thinking", active: true } as any);
    chatService
      .handle(text, { kind, seed }, { onUsage: recordChatUsage })
      .then((reply) => {
        wsHandler.broadcastRaw({ type: "thinking", active: false } as any);
        if (regionId) {
          // Region threads render "agent"-channel feed messages scoped by
          // regionId — same shape as the spawn reply path (escalator.pushResponse).
          wsHandler.broadcast(reply, "normal", "agent", regionId);
        } else {
          // Main chat thread expects sender:"agent" (mirrors commands.ts user
          // echo) — NOT the "stream" feed. Also feed the MAIN transcript for
          // session distillation; region threads are separate sessions and
          // must not pollute the main feed buffer.
          wsHandler.broadcastRaw({
            type: "feed", text: reply, priority: "normal",
            ts: Date.now(), channel: "agent", sender: "agent",
          } as any);
          feedBuffer.push(`[agent] ${reply}`, "normal", "system", "agent");
        }
      })
      .catch((e: Error) => {
        wsHandler.broadcastRaw({ type: "thinking", active: false } as any);
        if (regionId) {
          wsHandler.broadcast(`⚠ sinain-chat error: ${e.message}`, "normal", "agent", regionId);
        } else {
          wsHandler.broadcastRaw({
            type: "feed", text: `⚠ sinain-chat error: ${e.message}`, priority: "normal",
            ts: Date.now(), channel: "agent", sender: "agent",
          } as any);
        }
      });
  };

  // Desktop chat-app lane: compose the same ROI seed the sidecar would get,
  // stash it for the sinain_roi MCP pull, then open the app (Claude/ChatGPT) on
  // a pointer to that seed. No in-process reply stream — the conversation lives
  // in the desktop app; we just echo a one-line confirmation to the thread feed.
  const routeDesktopChat = async (text: string, regionId: string | undefined, agentName: string): Promise<void> => {
    const dType = desktopProfileType(escalatorAgentsCfg, agentName);
    if (!dType) return;
    escalator.noteUserChatting();
    // Same rich seed + same store + same id the terminal pulls — one mechanic.
    // Main-chat (no region) has no ROI seed: stash the user's text so the app
    // still has something to pull.
    // Region seed already absorbed any handoff transcript in composeAndStoreRoiSeed;
    // main-chat has no ROI seed, so fold the transcript (if any) into the stash.
    const composed = regionId ? await composeAndStoreRoiSeed(regionId) : null;
    const id = composed ? composed.id : roiSeeds.put(takeHandoffBlock("main") + text, "");
    launchDesktop(dType, id);
    const appLabel = dType === "claude_desktop" ? "Claude Desktop" : "ChatGPT";
    const note = `↗ Opened this in ${appLabel} — it pulls the context via sinain_roi.`;
    if (regionId) {
      wsHandler.broadcast(note, "normal", "agent", regionId);
    } else {
      wsHandler.broadcastRaw({
        type: "feed", text: note, priority: "normal",
        ts: Date.now(), channel: "agent", sender: "agent",
      } as any);
    }
  };

  // ── Wire overlay commands ──
  setupCommands({
    wsHandler,
    systemAudioPipeline,
    micPipeline,
    config,
    onUserMessage: async (text) => {
      await escalator.sendDirect(text);
    },
    onUserCommand: (text) => {
      // Record the user's side of MAIN in the feed buffer so fork seeds
      // (and session distillation) carry both halves of the conversation.
      feedBuffer.push(`[user] ${text}`, "normal", "system", "agent");

      // Resolve the chat agent for MAIN — a per-thread handoff override wins
      // over the global lane (so handing MAIN to another agent doesn't move the
      // ambient/default lane). Chat agent = sinain → resident sidecar; desktop
      // → external app; otherwise the escalation/run.sh path.
      const mainAgent = chatAgentFor("main");
      if (isSinainProfile(escalatorAgentsCfg, mainAgent)) {
        routeSinainChat(text);
        return;
      }
      if (isDesktopProfile(escalatorAgentsCfg, mainAgent)) {
        void routeDesktopChat(text, undefined, mainAgent);
        return;
      }

      escalator.setUserCommand(text);
      // Trigger agent loop immediately for user commands (bypass debounce + cooldown)
      agentLoop.onNewContext(true);
    },
    onUserBusy: (ms) => escalator.noteUserBusy(ms),
    onSetAutoDetect: (enabled) => {
      config.agentConfig.regionsEnabled = enabled;
      if (!enabled) {
        // Clear tracked regions + native eyes immediately
        regionTracker.clear();
        wsHandler.broadcastRaw({ type: "region_highlight", regions: [], ts: Date.now() });
      }
    },
    // Fast ROI restore: the overlay's NSWorkspace observer fires on app switch
    // ~1.5s before the sense pipeline catches up. Additively restore the new
    // app's archived eyes instantly (dimmed/pending); the sense path still does
    // the authoritative archive + urgent re-analysis when its event arrives.
    onAppFocus: (app) => {
      if (!app) return;
      const restored = regionTracker.restoreForApp(app);
      if (restored) {
        wsHandler.broadcastRaw({ type: "region_highlight", regions: restored, ts: Date.now() });
      }
    },
    onRegionSelect: (sel) => {
      void (async () => {
        try {
          // Tier 1 — reuse: recent sense events already carry per-line OCR
          // with frame-pixel bboxes. Scale each event's lines into screen
          // points and keep the ones whose center falls inside the selection.
          const collected: { text: string; bbox: [number, number, number, number] }[] = [];
          const recent = senseBuffer.queryByTime(Date.now() - 5 * 60_000);
          let app: string | undefined;
          for (const ev of recent) {
            if (ev.meta?.app) app = ev.meta.app;
            const fs = ev.frameSize;
            if (!ev.ocrLines?.length || !fs || fs.length !== 2 || !fs[0] || !fs[1]) continue;
            const sx = sel.screenW / fs[0];
            const sy = sel.screenH / fs[1];
            for (const ln of ev.ocrLines) {
              const [bx, by, bw, bh] = ln.bbox;
              const cx = (bx + bw / 2) * sx;
              const cy = (by + bh / 2) * sy;
              if (cx >= sel.x && cx <= sel.x + sel.w && cy >= sel.y && cy <= sel.y + sel.h) {
                collected.push({ text: ln.text, bbox: [bx * sx, by * sy, bw * sx, bh * sy] });
              }
            }
          }
          // Newest-first dedup by text (the same line appears across events)
          const seen = new Set<string>();
          const lines = collected.reverse().filter((l) => {
            const k = l.text.trim().toLowerCase();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          let text = lines.map((l) => l.text).join("\n");

          // Tier 2 — fresh crop-OCR of the live IPC frame when reuse came up
          // thin (area unchanged since capture start → SSIM gate never OCR'd it).
          if (text.length < 40) {
            try {
              const { execFile: ef } = await import("node:child_process");
              const { promisify: pf } = await import("node:util");
              const { stdout } = await pf(ef)(
                PYTHON_BIN,
                ["-m", "sense_client.ocr_once", JSON.stringify(sel)],
                { timeout: 10_000, encoding: "utf-8", cwd: SENSE_PKG_ROOT },
              );
              const fresh = JSON.parse(stdout.trim());
              if (fresh.ok && fresh.text) {
                text = fresh.text;
                log("regions", `manual ROI: tier-2 fresh OCR (${text.length} chars)`);
              } else if (!fresh.ok) {
                log("regions", `manual ROI: tier-2 OCR unavailable: ${fresh.error}`);
              }
            } catch (err) {
              log("regions", `manual ROI: tier-2 OCR failed: ${err}`);
            }
          } else {
            log("regions", `manual ROI: tier-1 reuse (${lines.length} lines, ${text.length} chars)`);
          }

          const region = regionTracker.addManual({
            bbox: [sel.x, sel.y, sel.w, sel.h],
            frameSize: [sel.screenW, sel.screenH],
            app,
            ocr: text || "(no readable text in the selection)",
          });
          wsHandler.broadcastRaw({
            type: "region_highlight",
            regions: regionTracker.current(),
            ts: Date.now(),
          } as any);
          log("regions", `manual region ${region.id} broadcast`);
        } catch (err) {
          log("regions", `manual region failed: ${err}`);
          wsHandler.broadcast(`\u26a0 Region selection failed: ${String(err).slice(0, 100)}`, "normal");
        }
      })();
    },
    onForkMain: () => {
      const id = `fork-${Date.now().toString(36)}`;
      const items = feedBuffer.query(0).filter((i) => i.channel === "agent").slice(-30);
      const transcript = items
        .map((i) => i.text.startsWith("[user] ")
          ? `User: ${i.text.slice(7)}`
          : `sinain: ${i.text}`)
        .join("\n\n");
      const digest = agentLoop.getDigest()?.digest;
      forkSeeds.set(id, [
        "You are continuing a FORK of the user's MAIN sinain chat. Below is",
        "the recent MAIN transcript and the situation digest at fork time.",
        "Pick up from this context — the user's next message continues it.",
        digest ? `\n## Situation digest\n${digest}` : "",
        transcript ? `\n## Recent MAIN transcript\n${transcript}` : "",
      ].filter(Boolean).join("\n"));
      return { id, label: "⑂ fork" };
    },
    onSetHandoffContext: (key, transcript) => {
      handoffContexts.set(key, transcript);
    },
    onSetThreadAgent: (key, agent) => {
      // Per-thread chat-agent override (handoff). "" clears it → the thread
      // falls back to the global lane. Does NOT touch bareAgentState, so the
      // default lane and ambient escalations are unaffected.
      if (agent) threadChatAgents.set(key, agent);
      else threadChatAgents.delete(key);
      log(TAG, `set_thread_agent ${key} → ${agent || "<default>"}`);
    },
    onSpawnCommand: (text, regionId) => {
      // Region/ROI chat uses the CHAT selector — there is no spawn lane. The
      // chat selector serves chat regardless of thread (chat + terminal are the
      // only lanes). When the chat agent is the sinain sidecar (the default),
      // route in-process; otherwise the task runs on the chat (escalation) lane
      // via dispatchSpawnTask (the region-task execution mechanism, no longer a
      // separate spawn selection).
      // A per-thread handoff override wins over the global lane for THIS region.
      const regionAgent = regionId ? chatAgentFor(regionId) : bareAgentState.escalationAgent;
      if (regionId && isSinainProfile(escalatorAgentsCfg, regionAgent)) {
        routeSinainChat(text, regionId);
        return;
      }
      if (regionId && isDesktopProfile(escalatorAgentsCfg, regionAgent)) {
        void routeDesktopChat(text, regionId, regionAgent);
        return;
      }
      let task = text;
      let label = "user-command";
      const opts: { regionId?: string; sessionKey?: string } = { regionId };
      if (regionId) {
        // Region thread: each ROI gets its own stable agent session on the chat
        // lane. First message carries the full region context; follow-ups are
        // the user's text and continue the same session.
        opts.sessionKey = `agent:main:region:${regionId}`;
        const region = regionTracker.get(regionId);
        const forkSeed = forkSeeds.get(regionId);
        label = region?.issue ? region.issue.slice(0, 48)
          : forkSeed ? "⑂ fork" : "region";
        if (!startedRegionThreads.has(regionId)) {
          startedRegionThreads.add(regionId);
          if (region) {
            // Overlay text on Run is a synthesized feed echo, not a user
            // note — the region itself carries the task content.
            task = buildRegionTaskText(region, agentLoop.getDigest()?.digest);
          } else if (forkSeed) {
            // Fork thread: first message = fork seed + the user's text
            // (unlike regions, the user's first message here is real).
            task = `${forkSeed}\n\n## User message\n${text}`;
          }
        }
        // Thread handoff onto a bare chat-lane agent: prepend the carried
        // transcript regardless of started state (handoff usually happens
        // mid-conversation, after the thread is already started).
        const handoff = takeHandoffBlock(regionId);
        if (handoff) task = handoff + task;
      }
      escalator.dispatchSpawnTask(task, label, opts).catch((err) => {
        log("cmd", `spawn command failed: ${err}`);
        wsHandler.broadcast(`\u26a0 Spawn failed: ${String(err).slice(0, 100)}`, "normal");
      });
    },
    onToggleScreen: () => {
      screenActive = !screenActive;
      if (!screenActive) {
        senseBuffer.clear();
      }
      wsHandler.updateState({ screen: screenActive ? "active" : "off" });
      return screenActive;
    },
    onToggleEscalation: () => {
      // Routes through the shared helpers so the set_agent("escalation","")
      // path and the flash-icon-toggle path share a single source of truth
      // for savedEscalationMode. Kept for WS backward-compat; new UI uses
      // the agent selector.
      if (config.escalationConfig.mode === "off") {
        resumeEscalationInternal();
        return true;
      } else {
        pauseEscalationInternal();
        return false;
      }
    },
    onSetEscalationEnabled: (enabled: boolean): boolean => {
      // Idempotent setter behind the overlay's On/Off chips (vs the legacy
      // flip-toggle). Shares savedEscalationMode bookkeeping via the same
      // helpers, so a user pause established here is protected by the
      // registerBareAgent reconcile guard exactly like the toggle path.
      if (enabled) {
        resumeEscalationInternal();
        return true;
      }
      pauseEscalationInternal();
      return false;
    },
    onSetIdleMessagesEnabled: (enabled: boolean): boolean => {
      // The ONLY thing that flips ambient/idle messages. Persisted so the
      // choice survives restarts; default OFF. Independent of escalation mode
      // and agent selection — nothing else can turn it on.
      idleMessagesEnabled = enabled;
      saveUiPrefs({ idleMessagesEnabled });
      log(TAG, `idle messages ${enabled ? "ON (ambient HUD messages WILL consume API tokens)" : "OFF"}`);
      return idleMessagesEnabled;
    },
      onSetChatgptHarness: (enabled: boolean): void => {
        chatgptHarnessEnabled = enabled;
        log(TAG, `chatgpt network harness ${enabled ? "ENABLED (public tunnel exposure)" : "disabled"}`);
        // Bring the public MCP tunnel up/down to match the toggle.
        if (enabled) void tunnelController.start(); else void tunnelController.stop();
        // Re-evaluate the roster with the new flag — the desktop add/filter in
        // registerBareAgent surfaces or drops chatgpt-desktop accordingly.
        registerBareAgent(bareAgentState.available, bareAgentState.escalationAgent, bareAgentState.registered);
      },
      onMcpTunnelSignin: (): void => { void tunnelController.signIn(); },
      onMcpTunnelSignout: (): void => { void tunnelController.signOut(); },
      onSetAgent: (lane: "escalation" | "terminal", agent: string): { ok: boolean; error?: string } => {
      // Empty-string agent = Off (lane disabled). Non-empty agent must be in
      // the lane's roster: the chat/escalation lane draws from the full roster
      // (sinain-eligible); the terminal lane draws from the sinain-excluded
      // terminal roster. Stale overlay state can send something out of range —
      // reject with a clear error.
      if (agent !== "") {
        const roster = lane === "escalation"
          ? bareAgentState.available
          : bareAgentState.terminalAvailable;
        if (!roster.includes(agent)) {
          return { ok: false, error: `Agent "${agent}" not available in the ${lane} roster` };
        }
      }
      if (lane === "escalation") {
        const prevAgent = bareAgentState.escalationAgent;
        bareAgentState.escalationAgent = agent;
        bareAgentState.escalationResident = isSinainProfile(escalatorAgentsCfg, agent);
        bareAgentState.escalationDesktop = isDesktopProfile(escalatorAgentsCfg, agent);
        if (agent === "") {
          pauseEscalationInternal();
        } else {
          resumeEscalationInternal();
        }
        // If the user flipped to a gateway-typed agent (openclaw, nemoclaw,
        // ...) and there's a stale httpPending escalation queued from BEFORE
        // the switch, re-dispatch it through the WS path. Without this, the
        // bare agent picks up the stale entry on its next poll and posts a
        // "[skipped: gateway-routed]" message to the HUD — confusing for
        // the user, who just told us "use the gateway".
        const wasGateway = isGatewayProfile(escalatorAgentsCfg, prevAgent);
        const isGateway = isGatewayProfile(escalatorAgentsCfg, agent);
        if (!wasGateway && isGateway) {
          const did = escalator.redispatchHttpPendingToWs();
          if (did) log(TAG, `lane switch ${prevAgent || "<empty>"} → ${agent}: stale httpPending redispatched`);
        }
      } else {
        // terminal lane — which agent the interactive thread terminal launches
        // (run.sh --interactive-main). Pure selection; no escalator/WS effect.
        bareAgentState.terminalAgent = agent;
      }
      // Re-evaluate WS lifecycle: connect when a gateway lane just got
      // selected (zero attempts before this point), disconnect when the user
      // moved off every gateway lane. This is what makes the "no resources
      // when not in use" guarantee hold across runtime selection changes,
      // not just startup config.
      escalator.evaluateGatewayLifecycle();
      // Rebroadcast state so the overlay sees the switch immediately, and
      // the bare agent sees it on its next poll-response config piggyback.
      // `escalation` field reflects the current escalator mode so the flash
      // icon's color (active/paused) updates on Off-for-escalation.
      wsHandler.updateState({
        agents: { ...bareAgentState },
        escalation: config.escalationConfig.mode === "off" ? "paused" : "active",
      });
      const displayAgent = agent || "off";
      wsHandler.broadcast(`Agent switched: ${lane} → ${displayAgent}`, "normal", "stream");
      log(TAG, `set_agent lane=${lane} agent=${displayAgent}`);
      return { ok: true };
    },
    onStartLocalAgent: (agent?: string) => startLocalAgent(agent),
    onRestartChatSidecar: () => restartChatSidecar(),
  });

  // Broadcast initial screen state so overlay gets correct status on connect
  wsHandler.updateState({ screen: "active" });

  // ── Start services ──
  try {
    await server.start();
  } catch (err) {
    error(TAG, "failed to start server:", err);
    process.exit(1);
  }

  // Start profiler
  profiler.start();
  // Periodically sample buffer gauges
  // Service guard: broadcast per-service liveness to the overlay every 10s (and
  // on change) so the HUD banner reflects a stale/dead service promptly.
  let lastServicesKey = "";
  const serviceGuardTimer = setInterval(() => {
    const svc = serviceStatuses();
    const key = svc.map((s) => `${s.name}:${s.state}`).join("|");
    if (key !== lastServicesKey) {
      lastServicesKey = key;
      wsHandler.updateState({ services: svc } as any);
    }
  }, 10_000);

  const bufferGaugeTimer = setInterval(() => {
    profiler.gauge("buffer.feed", feedBuffer.size);
    profiler.gauge("buffer.sense", senseBuffer.size);
    profiler.gauge("buffer.feed.hwm", feedBuffer.hwm);
    profiler.gauge("buffer.sense.hwm", senseBuffer.hwm);
    profiler.gauge("ws.clients", wsHandler.clientCount);
  }, 10_000);

  // Start escalation WS connection
  escalator.start();

  // Start periodic feedback summary (every 30 minutes, offset from startup)
  const feedbackSummaryTimer = config.learningConfig.enabled
    ? setInterval(() => {
        escalator.sendFeedbackSummary().catch(err => {
          warn(TAG, "feedback summary error:", err);
        });
      }, 30 * 60 * 1000)
    : null;

  // Start agent loop
  agentLoop.start();

  // Auto-start system audio if configured
  if (config.audioConfig.autoStart) {
    log(TAG, "auto-starting system audio pipeline...");
    systemAudioPipeline.start();
  } else {
    log(TAG, "system audio pipeline ready (not auto-started \u2014 send toggle_audio or set AUDIO_AUTO_START=true)");
  }

  // Auto-start mic if configured
  if (micPipeline && config.micConfig.autoStart) {
    log(TAG, "auto-starting mic pipeline...");
    micPipeline.start();
  } else if (micPipeline) {
    log(TAG, "mic pipeline ready (not auto-started \u2014 send toggle_mic or set MIC_AUTO_START=true)");
  }

  log(TAG, "\u2713 sinain-core running");
  log(TAG, `  http+ws: http://0.0.0.0:${config.port}`);
  log(TAG, `  audio:   ${config.audioConfig.autoStart ? "active" : "standby"} (${config.audioConfig.captureCommand})`);
  log(TAG, `  mic:     ${config.micEnabled ? (config.micConfig.autoStart ? "active" : "standby") : "disabled"}`);
  log(TAG, `  agent:   ${config.agentConfig.enabled ? "enabled" : "disabled"}`);
  log(TAG, `  escal:   ${config.escalationConfig.mode}`);
  log(TAG, `  cost:    display=${config.costDisplayEnabled ? "on" : "off"} (always logged)`);

  // ── Distill any leftover pending session from a prior shutdown ──
  // Deferred until here, after server.start() has bound the port and /health is
  // answerable, so the synchronous (execFileSync) distillation can't starve the
  // startup health gate. The short delay also lets the overlay's first health
  // checks land before the event loop blocks on the f-coref model load.
  setTimeout(() => {
    try {
      localCuration.distillPendingSession();
    } catch (err: any) {
      warn(TAG, `pending session distillation failed: ${err.message?.slice(0, 100)}`);
    }
  }, 5000);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
    shuttingDown = true;
    clearInterval(bufferGaugeTimer);
    if (feedbackSummaryTimer) clearInterval(feedbackSummaryTimer);
    costTracker.stop();
    profiler.stop();
    recorder.forceStop(); // Stop any active recording
    agentLoop.stop();
    systemAudioPipeline.stop();
    if (micPipeline) micPipeline.stop();
    transcription.destroy();
    escalator.stop();
    void tunnelController.stop(); // kill frpc + the HTTP MCP transport
    if (localAgentProcess && localAgentProcess.exitCode === null) {
      localAgentProcess.kill("SIGTERM");
    }
    if (kgDaemonProc && kgDaemonProc.exitCode === null) {
      try { process.kill(-kgDaemonProc.pid!); } catch { try { kgDaemonProc.kill("SIGTERM"); } catch { /* gone */ } }
    }
    signalCollector?.destroy();
    feedbackStore?.destroy();
    traceStore?.destroy();

    // Save session knowledge — write feed items to disk FIRST (instant),
    // then attempt LLM distillation. If tsx force-kills before distillation
    // finishes, the saved file is recovered on next startup.
    localCuration.stop();
    const feedItems = feedBuffer.query(0);
    try {
      localCuration.savePendingSession(feedItems);
    } catch (err: any) {
      warn(TAG, `failed to save pending session: ${err.message?.slice(0, 100)}`);
    }
    try {
      if (feedItems.length >= 3) {
        log(TAG, `distilling session (${feedItems.length} feed items)...`);
        await localCuration.distillSession(feedItems);
      }
    } catch (err: any) {
      warn(TAG, `session distillation failed (will retry on next startup): ${err.message?.slice(0, 100)}`);
    }

    await server.destroy();
    log(TAG, "goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    error(TAG, "uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    error(TAG, "unhandled rejection:", reason);
  });
}

main().catch((err) => {
  error(TAG, "fatal:", err);
  process.exit(1);
});
