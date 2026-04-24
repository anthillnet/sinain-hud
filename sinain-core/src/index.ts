import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { setupCommands } from "./overlay/commands.js";
import { AudioPipeline } from "./audio/pipeline.js";
import type { CaptureSpawner } from "./audio/capture-spawner.js";
import { TranscriptionService } from "./audio/transcription.js";
import { AgentLoop } from "./agent/loop.js";
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
import { Profiler } from "./profiler.js";
import { CostTracker } from "./cost/tracker.js";
import type { SenseEvent, EscalationMode, FeedItem } from "./types.js";
import { isDuplicateTranscript, bigramSimilarity } from "./util/dedup.js";
import { log, warn, error } from "./log.js";
import { initPrivacy, levelFor, applyLevel } from "./privacy/index.js";

const TAG = "core";

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

/**
 * Query knowledge facts from both local and workspace databases.
 * Checks local (~/.sinain/memory) first, then workspace (~/.openclaw/workspace/memory).
 * Merges results, deduplicates, returns up to maxFacts.
 */
async function queryKnowledgeFactsMulti(entities: string[], maxFacts: number): Promise<string> {
  const { execFileSync } = await import("node:child_process");
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

  // Candidate script paths
  const __dir = dirname(fileURLToPath(import.meta.url));
  const scriptCandidates = [
    resolve(__dir, "..", "..", "sinain-hud-plugin", "sinain-memory", "graph_query.py"),
    resolve(__dir, "..", "sinain-memory", "graph_query.py"),
    `${resolveWorkspace()}/sinain-memory/graph_query.py`,
  ];
  const scriptPath = scriptCandidates.find(p => existsSync(p)) || scriptCandidates[0];

  // Step 1: Get candidates from Python (RRF-ranked, no embedding — avoids deadlock)
  // Request 2x candidates in JSON for re-ranking in Node.js
  const candidateFacts: Array<Record<string, string>> = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const args = [scriptPath, "--db", dbPath, "--max-facts", String(maxFacts * 2), "--format", "json"];
      if (entities.length > 0) args.push("--entities", JSON.stringify(entities));
      const out = execFileSync("python3", args, { timeout: 5000, encoding: "utf-8" }).trim();
      if (out) {
        const parsed = JSON.parse(out);
        const facts = parsed.facts || parsed;
        if (Array.isArray(facts)) candidateFacts.push(...facts);
      }
    } catch { /* skip failed db */ }
  }

  if (candidateFacts.length === 0) return "";

  // Step 2: Re-rank by embedding similarity in-process (no deadlock — model is in this process)
  const queryText = entities.join(" ");
  try {
    if (embeddingService?.ready) {
      const allTexts = [queryText, ...candidateFacts.map(f => f.value || "")];
      const embeddings = await embeddingService.embed(allTexts);
      const queryEmb = embeddings[0];
      const scored = candidateFacts.map((f, i) => ({
        fact: f,
        sim: EmbeddingService.cosine(queryEmb, embeddings[i + 1]),
      }));
      scored.sort((a, b) => b.sim - a.sim);
      candidateFacts.length = 0;
      candidateFacts.push(...scored.slice(0, maxFacts).map(s => s.fact));
    }
  } catch { /* embedding unavailable — use RRF order */ }

  // Step 3: Format as compact text
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  const maxChars = 1200;
  for (const f of candidateFacts.slice(0, maxFacts)) {
    const eid = ((f as any).entity_id || (f as any).entityId || "").split(":").pop()?.slice(0, 20) || "?";
    const value = (f as any).value || "";
    const conf = (f as any).confidence || "?";
    const count = (f as any).reinforce_count || "1";
    const line = `${eid}: ${value} (${conf},${count}x)`;
    const key = value.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    if (total + line.length + 2 > maxChars) break;
    lines.push(line);
    total += line.length + 2;
  }
  return lines.join("; ");
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

  const __dir = dirname(fileURLToPath(import.meta.url));
  const scriptCandidates = [
    resolve(__dir, "..", "..", "sinain-hud-plugin", "sinain-memory", "graph_query.py"),
    resolve(__dir, "..", "sinain-memory", "graph_query.py"),
    `${resolveWorkspace()}/sinain-memory/graph_query.py`,
  ];
  const scriptPath = scriptCandidates.find(p => existsSync(p)) || scriptCandidates[0];

  const allFacts: any[] = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync("python3", [
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

  const __dir = dirname(fileURLToPath(import.meta.url));
  const scriptCandidates = [
    resolve(__dir, "..", "..", "sinain-hud-plugin", "sinain-memory", "graph_query.py"),
    `${resolveWorkspace()}/sinain-memory/graph_query.py`,
  ];
  const scriptPath = scriptCandidates.find(p => existsSync(p)) || scriptCandidates[0];

  const allFacts: any[] = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync("python3", [
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
  const scriptsDir = resolve(__dir, "..", "..", "sinain-hud-plugin", "sinain-memory");

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
    // Use triplestore directly via Python
    const script = `
import json, sys
sys.path.insert(0, "${scriptsDir}")
from triplestore import TripleStore
import hashlib

db_path = "${dbPath}"
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
    store.assert_triple(tx, entity_id, "first_seen", "${new Date().toISOString()}")
    store.assert_triple(tx, entity_id, "last_reinforced", "${new Date().toISOString()}")
    store.assert_triple(tx, entity_id, "reinforce_count", "1")
    if op.get("domain"):
        store.assert_triple(tx, entity_id, "domain", op["domain"])
    stats["asserted"] += 1

store.close()
print(json.dumps(stats))
`;

    const result = execFileSync("python3", ["-c", script], {
      input: JSON.stringify(graphOps),
      timeout: 10_000,
      encoding: "utf-8",
    });

    const stats = JSON.parse(result.trim());
    return JSON.stringify({ ok: true, stats, imported: stats.asserted, skipped: stats.skipped });
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: err.message?.slice(0, 200) });
  }
}

async function main() {
  log(TAG, "sinain-core starting...");

  // ── Load config ──
  const config = loadConfig();
  log(TAG, `port: ${config.port}`);
  log(TAG, `audio: device=${config.audioConfig.device} cmd=${config.audioConfig.captureCommand} chunk=${config.audioConfig.chunkDurationMs}ms`);
  log(TAG, `mic: enabled=${config.micEnabled} device=${config.micConfig.device} cmd=${config.micConfig.captureCommand}`);
  log(TAG, `transcription: model=${config.transcriptionConfig.geminiModel}`);
  log(TAG, `agent: model=${config.agentConfig.model} debounce=${config.agentConfig.debounceMs}ms max=${config.agentConfig.maxIntervalMs}ms`);
  log(TAG, `escalation: mode=${config.escalationConfig.mode} cooldown=${config.escalationConfig.cooldownMs}ms stale=${config.escalationConfig.staleMs}ms`);
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

  // ── Initialize local knowledge pipeline ──
  // Pass wsHandler.broadcast so the periodic curator (insight_synthesizer)
  // can push suggestions/insights directly to HUD without going through the
  // bare-agent heartbeat. Replaces the old sinain_post_feed MCP roundtrip.
  const localCuration = new LocalCurationService(
    (text) => wsHandler.broadcast(text),
  );
  // Distill pending session in background — don't block server startup
  setImmediate(() => {
    localCuration.distillPendingSession();
  });
  localCuration.startPeriodicCuration();

  // Wire incremental distillation: when feed buffer fills, distill before items are lost
  localCuration.setSenseBuffer(senseBuffer);
  localCuration.setRearmCallback(() => feedBuffer.rearmOnFull());
  feedBuffer.onFull((items) => {
    localCuration.distillIncremental(items);
  });

  // ── Initialize escalation ──
  // getSpawnAgent reads bareAgentState (declared later in this function) via
  // closure at call-time, NOT at construction time. Safe because
  // dispatchSpawnTask only fires after an overlay message, which can't
  // happen before server setup completes.
  const escalator = new Escalator({
    feedBuffer,
    wsHandler,
    escalationConfig: config.escalationConfig,
    openclawConfig: config.openclawConfig,
    profiler,
    feedbackStore: feedbackStore ?? undefined,
    queryKnowledgeFacts: queryKnowledgeFactsMulti,
    getSpawnAgent: () => bareAgentState.spawnAgent,
    getEscalationAgent: () => bareAgentState.escalationAgent,
  });

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
  const WHITELIST_AGENTS = new Set([
    "claude", "openclaude", "codex", "goose", "junie", "aider",
    // "openclaw" is injected server-side below when gatewayWsUrl is set —
    // it's not a local CLI, it's a routing choice that sends tasks to the
    // remote OpenClaw gateway via WS RPC instead of the local bare agent.
    "openclaw",
  ]);
  const bareAgentState: {
    available: string[];
    escalationAgent: string;
    spawnAgent: string;
  } = { available: [], escalationAgent: "", spawnAgent: "" };

  function registerBareAgent(availableList: string[], current: string): void {
    const clean = availableList.filter((a) => WHITELIST_AGENTS.has(a));
    // Inject "openclaw" as a roster option when an OpenClaw gateway is
    // configured. Lets the user explicitly route a lane to the remote
    // gateway (e.g., picking "openclaw" for spawn means "use the gateway's
    // subagent", picking "claude" means "use local claude binary").
    if (config.openclawConfig.gatewayWsUrl && !clean.includes("openclaw")) {
      clean.push("openclaw");
    }
    bareAgentState.available = clean;
    // If neither lane is set yet (fresh boot), adopt the bare agent's
    // reported current. If state survives from a prior register call AND
    // the agent still exists in the roster, keep it; otherwise fall back
    // to the new current.
    if (!bareAgentState.escalationAgent || !clean.includes(bareAgentState.escalationAgent)) {
      bareAgentState.escalationAgent = clean.includes(current) ? current : (clean[0] ?? "");
    }
    if (!bareAgentState.spawnAgent || !clean.includes(bareAgentState.spawnAgent)) {
      bareAgentState.spawnAgent = clean.includes(current) ? current : (clean[0] ?? "");
    }
    wsHandler.updateState({ agents: { ...bareAgentState } });
    log(TAG, `bareagent register: available=[${clean.join(",")}] current=${current} → lanes esc=${bareAgentState.escalationAgent} spawn=${bareAgentState.spawnAgent}`);
  }

  // ── Create HTTP + WS server ──
  const server = createAppServer({
    config,
    feedBuffer,
    senseBuffer,
    wsHandler,
    profiler,
    costTracker,
    feedbackStore: feedbackStore ?? undefined,
    isScreenActive: () => screenActive,

    onSenseEvent: (event: SenseEvent) => {
      // Respect toggle_screen — if user disabled screen, ignore sense events
      if (!screenActive) return;

      wsHandler.updateState({ screen: "active" });

      // Track app context for recorder
      recorder.onSenseEvent(event);

      // Broadcast app/window changes to overlay
      if (event.type === "text" && event.ocr && event.ocr.trim().length > 10) {
        const app = shortAppName(event.meta.app || "");
        const firstLine = event.ocr.split("\n").find((l: string) => l.trim().length > 5)?.trim() || event.ocr.split("\n")[0].trim();
        const text = firstLine.slice(0, 80);
        const prefix = app ? `${app}: ` : "";
        wsHandler.broadcast(`[\ud83d\udc41] ${prefix}${text}`, "normal");
      }

      // Trigger debounced agent analysis
      agentLoop.onNewContext();
    },

    onFeedPost: (text: string, priority: string) => {
      const item = feedBuffer.push(text, priority as any, "system", "stream");
      wsHandler.broadcast(text, priority as any);
      agentLoop.onNewContext();
      log(TAG, `[feed] #${item.id}: ${text.slice(0, 80)}`);
    },

    onSenseProfile: (snapshot) => profiler.reportSense(snapshot),

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
      spawnAgent: bareAgentState.spawnAgent,
      // Tells the bare agent whether core still has its roster. On core
      // restart this flips to false until the next /bareagent/register POST
      // — distinguishes "user picked Off/Off" (registered=true, lanes="")
      // from "core forgot about us" (registered=false).
      registered: bareAgentState.available.length > 0,
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
      escalator.setUserCommand(text);
      // Trigger agent loop immediately for user commands (bypass debounce + cooldown)
      agentLoop.onNewContext(true);
    },
    onSpawnCommand: (text) => {
      escalator.dispatchSpawnTask(text, "user-command").catch((err) => {
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
    onSetAgent: (lane: "escalation" | "spawn", agent: string): { ok: boolean; error?: string } => {
      // Empty-string agent = Off (lane disabled). Non-empty agent must be
      // in the current roster; stale overlay state can send something that
      // isn't available — reject with a clear error.
      if (agent !== "" && !bareAgentState.available.includes(agent)) {
        return { ok: false, error: `Agent "${agent}" not available` };
      }
      if (lane === "escalation") {
        bareAgentState.escalationAgent = agent;
        if (agent === "") {
          pauseEscalationInternal();
        } else {
          resumeEscalationInternal();
        }
      } else {
        bareAgentState.spawnAgent = agent;
        // Spawn "off" just means run.sh won't poll /spawn/pending; no
        // server-side state to flip. Queued spawn tasks TTL out naturally.
      }
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

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
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
