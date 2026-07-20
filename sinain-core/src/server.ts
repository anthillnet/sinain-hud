import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentEventFrame, CoreConfig, SenseEvent } from "./types.js";
import type { AgentSessionRegistry } from "./agent-sessions/registry.js";
import type { ApprovalManager } from "./agent-sessions/approvals.js";
import { appendBuildContextBrief, composeEnrichBrief } from "./agent-sessions/enrich.js";
import { buildContextWindow } from "./agent/context-window.js";
import type { Profiler } from "./profiler.js";
import type { CostTracker } from "./cost/tracker.js";
import type { FeedbackStore } from "./learning/feedback-store.js";
import type { WebDb, BookmarkStatus } from "./web-db/store.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer, type SemanticSenseEvent, type TextDelta } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { roiSeeds } from "./chat/roi-seeds.js";
import { handleWikiRoute } from "./wiki/routes.js";
import { renderWikiUi } from "./wiki/ui.js";
import { log, error } from "./log.js";

const TAG = "server";
const MAX_SENSE_BODY = 2 * 1024 * 1024;

const KNOWLEDGE_UI_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>Sinain Knowledge</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; margin: 0; padding: 20px; }
  h1 { color: #00ff88; font-size: 18px; }
  h2 { color: #00cc66; font-size: 14px; margin-top: 20px; }
  .card { background: #16213e; border-radius: 8px; padding: 12px; margin: 8px 0; border-left: 3px solid #00ff88; }
  .card .domain { color: #00ff88; font-size: 11px; text-transform: uppercase; }
  .card .value { margin-top: 4px; }
  .card .meta { color: #888; font-size: 11px; margin-top: 4px; }
  .controls { display: flex; gap: 10px; margin: 16px 0; flex-wrap: wrap; }
  button { background: #00ff88; color: #1a1a2e; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
  button:hover { background: #00cc66; }
  button.secondary { background: #333; color: #ccc; }
  input, select { background: #16213e; color: #e0e0e0; border: 1px solid #333; padding: 8px; border-radius: 4px; }
  #status { color: #00ff88; font-size: 12px; margin: 8px 0; }
  #facts { max-height: 70vh; overflow-y: auto; }
  .import-area { margin: 16px 0; }
  textarea { width: 100%; height: 100px; background: #16213e; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 12px; }
</style>
</head><body>
<h1>Sinain Knowledge Graph</h1>
<div class="controls">
  <input id="search" type="text" placeholder="Search entities..." oninput="filterFacts()">
  <select id="domainFilter" onchange="filterFacts()"><option value="">All domains</option></select>
  <button onclick="loadFacts()">Refresh</button>
  <button onclick="exportKnowledge()" class="secondary">Export</button>
  <button onclick="exportDomain()" class="secondary">Export Domain</button>
</div>
<div id="status">Loading...</div>
<div id="facts"></div>

<h2>Import Knowledge</h2>
<div class="import-area">
  <textarea id="importData" placeholder="Paste exported JSON here, or enter a URL to fetch from another sinain instance..."></textarea>
  <div class="controls">
    <button onclick="importKnowledge()">Import</button>
    <button onclick="importFromUrl()" class="secondary">Import from URL</button>
  </div>
</div>

<script>
let allFacts = [];

async function loadFacts() {
  document.getElementById('status').textContent = 'Loading...';
  try {
    const res = await fetch('/knowledge/entities?max=1000');
    const data = await res.json();
    allFacts = typeof data.entities === 'string' ? JSON.parse(data.entities) : data.entities;
    const domains = [...new Set(allFacts.map(f => f.domain).filter(Boolean))].sort();
    const sel = document.getElementById('domainFilter');
    sel.innerHTML = '<option value="">All domains (' + allFacts.length + ')</option>' +
      domains.map(d => '<option value="' + d + '">' + d + ' (' + allFacts.filter(f=>f.domain===d).length + ')</option>').join('');
    document.getElementById('status').textContent = allFacts.length + ' entities loaded';
    filterFacts();
  } catch (e) { document.getElementById('status').textContent = 'Error: ' + e.message; }
}

function filterFacts() {
  const q = document.getElementById('search').value.toLowerCase();
  const domain = document.getElementById('domainFilter').value;
  const filtered = allFacts.filter(f => {
    if (domain && f.domain !== domain) return false;
    if (q) {
      const text = JSON.stringify(f).toLowerCase();
      return text.includes(q);
    }
    return true;
  });
  document.getElementById('facts').innerHTML = filtered.map(f =>
    '<div class="card">' +
    '<span class="domain">' + (f.domain||'general') + '</span>' +
    '<div class="value">' + esc(f.entity || f.entityId || '?') + ': ' + esc(f.value||'') + '</div>' +
    '<div class="meta">confidence: ' + (f.confidence||'?') + ' | confirmed: ' + (f.reinforce_count||1) + 'x | id: ' + esc(f.entityId||'') + '</div>' +
    '</div>'
  ).join('');
  document.getElementById('status').textContent = filtered.length + ' of ' + allFacts.length + ' entities';
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function exportKnowledge() {
  window.open('/knowledge/export?max=500', '_blank');
}

async function exportDomain() {
  const domain = document.getElementById('domainFilter').value;
  if (!domain) { alert('Select a domain first'); return; }
  window.open('/knowledge/export?domain=' + encodeURIComponent(domain) + '&max=500', '_blank');
}

async function importKnowledge() {
  const el = document.getElementById('status');
  const data = document.getElementById('importData').value.trim();
  if (!data) { el.textContent = 'Error: paste JSON data first'; return; }
  el.textContent = 'Importing...';
  try {
    JSON.parse(data); // validate JSON first
  } catch(e) { el.textContent = 'Error: invalid JSON — ' + e.message; return; }
  try {
    const res = await fetch('/knowledge/import', { method: 'POST', body: data });
    const text = await res.text();
    console.log('Import response:', text);
    const result = JSON.parse(text);
    el.textContent = result.ok
      ? 'Imported ' + (result.imported||0) + ' facts, skipped ' + (result.skipped||0)
      : 'Error: ' + (result.error||'unknown');
    if (result.ok) { document.getElementById('importData').value = ''; loadFacts(); }
  } catch (e) { el.textContent = 'Import failed: ' + e.message; console.error(e); }
}

async function importFromUrl() {
  const el = document.getElementById('status');
  const input = document.getElementById('importData').value.trim();
  if (!input.startsWith('http')) { el.textContent = 'Error: enter a URL starting with http'; return; }
  el.textContent = 'Fetching from ' + input + '...';
  try {
    const res = await fetch(input);
    if (!res.ok) { el.textContent = 'Fetch failed: HTTP ' + res.status; return; }
    const data = await res.text();
    el.textContent = 'Fetched ' + data.length + ' bytes, importing...';
    const importRes = await fetch('/knowledge/import', { method: 'POST', body: data });
    const result = await importRes.json();
    el.textContent = result.ok
      ? 'Imported ' + (result.imported||0) + ' facts from URL, skipped ' + (result.skipped||0)
      : 'Error: ' + (result.error||'unknown');
    if (result.ok) { document.getElementById('importData').value = ''; loadFacts(); }
  } catch (e) { el.textContent = 'Fetch error: ' + e.message + ' (CORS may block cross-origin URLs — use export file instead)'; console.error(e); }
}

loadFacts();
</script>
</body></html>`;


/** Server epoch — lets clients detect restarts. */
const serverEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export interface ServerDeps {
  config: CoreConfig;
  feedBuffer: FeedBuffer;
  senseBuffer: SenseBuffer;
  wsHandler: WsHandler;
  agentSessions?: {
    registry: AgentSessionRegistry;
    approvals: ApprovalManager;
    activeSessions?: () => { id: string; threadId: string; label: string; startTs: number; paused: boolean }[];
    sessionAssist?: (threadId: string) => { goal: string; steps: string[] } | null;
    factLinesSince?: (threadId: string, since: number) => string[];
  };
  profiler?: Profiler;
  costTracker?: CostTracker;
  onSenseEvent: (event: SenseEvent) => void;
  /** Frame-rate visual change from sense_client (cheap, ungated by OCR
   *  cooldown): (dx,dy) is the scroll translation — eyes glide with content;
   *  changedBoxes are frame-px regions that changed BEYOND the scroll (content
   *  replaced) — eyes there are dimmed (gone). Together they move eyes
   *  precisely and retire them the instant their content leaves. */
  onMotion?: (
    dx: number, dy: number,
    changedBoxes: [number, number, number, number][],
    app: string, display: number,
  ) => void;
  onSenseDelta?: (data: { app: string; activity: string; changes: TextDelta[]; priority?: string; ts: number }) => void;
  onFeedPost: (text: string, priority: string) => void;
  isScreenActive: () => boolean;
  onSenseProfile: (snapshot: any) => void;
  getHealthPayload: () => Record<string, unknown>;
  getAgentDigest: () => unknown;
  getAgentHistory: (limit: number) => unknown[];
  getAgentContext: () => unknown;
  getAgentConfig: () => unknown;
  updateAgentConfig: (updates: Record<string, unknown>) => unknown;
  getTraces: (after: number, limit: number) => unknown[];
  reconnectGateway: () => void;
  feedbackStore?: FeedbackStore;
  setUserCommand?: (text: string) => void;
  getEscalationPending?: () => any;
  isEscalationPaused?: () => boolean;
  respondEscalation?: (id: string, response: string) => any;
  /** Composed rich ROI seed (issue + OCR + digest + knowledge), stored under an
   *  id for the unified sinain_roi pull. Returns {id, text}: `text` for legacy
   *  embedding, `id` so the terminal can instead pull via sinain_roi — the same
   *  mechanic Claude Desktop / ChatGPT use. */
  getRegionTask?: (regionId: string) => Promise<{ id: string; text: string } | null>;
  /** One-shot pending handoff transcript block for a thread key ("main" or a
   *  regionId) — consumed by the MAIN interactive terminal (region/desktop
   *  seeds fold it in directly). Returns "" when none pending. */
  getHandoffBlock?: (key: string) => string;
  /** Mint an roiSeed from arbitrary text → returns its id for the unified
   *  sinain_roi MCP pull. Lets interactive terminals seed ANY context (main
   *  digest, fallbacks) through the MCP mechanic — never a seed file on disk. */
  mintRoiSeed?: (text: string) => string;
  /** Build a portable seed (the same context we feed agents, knowledge inlined)
   *  for the clipboard "copy seed" action. key = regionId or "main"; null when
   *  the region is unknown. */
  buildSeed?: (key: string, transcript?: string, focus?: string) => Promise<string | null>;
  /** Stable agent session for a thread (get-or-create) — terminals resume it. */
  getThreadSession?: (regionId: string) => { sessionId: string; isNew: boolean };
  getKnowledgeDocPath?: () => string | null;
  queryKnowledgeFacts?: (entities: string[], maxFacts: number) => Promise<string>;
  listKnowledgeEntities?: (max: number) => Promise<string>;
  queryKnowledgeAsOf?: (entity: string, date: string) => Promise<string>;
  exportKnowledge?: (domain: string | null, max: number) => Promise<string>;
  importKnowledge?: (data: string) => Promise<string>;
  onSpawnCommand?: (text: string) => void;
  getSpawnPending?: () => { id: string; task: string; label: string; ts: number } | null;
  respondSpawn?: (id: string, result: string) => { ok: boolean; error?: string };
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>;
  isEmbeddingReady?: () => boolean;

  /** Web UI metadata DB (bookmarks, page cache, retraction undo). */
  webDb?: WebDb;
  /** Search entities by query (FTS5 + entity ref grouping). */
  searchEntities?: (q: string, limit: number) => Promise<unknown>;
  /** Lazy-load entity graph children (one level via VAET backref). */
  graphChildren?: (entity: string) => Promise<unknown>;
  /** Render a Confluence-style page for an entity (cached via web.db). */
  renderEntityPage?: (entity: string, opts: { refresh: boolean; maxFacts: number }) => Promise<unknown>;
  /** Retract a fact entity (soft-delete in triplestore + audit triples + undo snapshot). */
  retractFact?: (factId: string, reason: string | null, actor: string | null, sourceEntity: string | null) => Promise<unknown>;
  /** Restore a previously retracted fact via undo token. */
  restoreFact?: (factId: string, undoToken: string) => Promise<unknown>;
  /** Knowledge lint — report or bulk-apply retractions (lint_knowledge.py). */
  lintKnowledge?: (apply: boolean, aggressive: boolean) => Promise<unknown>;
  /** Export a concept bundle (entity + neighborhood) for transfer between machines. */
  exportConcept?: (entity: string, depth: number, opts: { includeRetracted: boolean; includePage: boolean; redactRules: string[] }) => Promise<unknown>;
  /** Import a concept bundle into the local knowledge graph. */
  importConcept?: (envelope: unknown, conflict: "skip" | "merge" | "overwrite") => Promise<unknown>;

  // ── Deliberate capture (save / summon / enrich on the rolling window) ──
  /** Kick off "save last N minutes" → returns saveId; receipt flows via WS. */
  captureSave?: (minutes: number, apps?: string[]) => string;
  /** Cancel a save inside its undo window. */
  captureUndo?: (saveId: string) => boolean;
  /** Retry a failed save using its retained transcript. */
  captureRetry?: (saveId: string) => boolean;
  /** Overlay response to a breakpoint save offer (accepted/adjusted/dismissed/expired). */
  captureOfferResponse?: (offerId: string, response: string, minutes?: number, apps?: string[]) => { ok: boolean; saveId?: string; error?: string };
  /** Overlay response to a Session Sense nudge (tracked/corrected/dismissed/expired). */
  sessionNudgeResponse?: (nudgeId: string, response: string, label?: string) => { ok: boolean; sessionId?: string; error?: string };
  /** Session actions from the wrap card / chip (wrapped/keep_going/ended/later). */
  sessionAction?: (sessionId: string, action: string) => { ok: boolean; saveId?: string; error?: string };
  /** Bookmarked-session shelf rows (§9), without kgPath. */
  sessionBookmarks?: () => import("./types.js").SessionBookmarkRow[];
  /** Live-session snapshots for the sessions list (warm first; [] when idle). */
  sessionActive?: () => unknown[];
  /** Shelf actions: ▶ resume (fresh session, no detection wait) / ✕ remove. */
  sessionBookmarkAction?: (threadId: string, action: string) => { ok: boolean; sessionId?: string; error?: string };
  /** "Call AI on my last N minutes" → situation brief (also broadcast via WS). */
  contextSummon?: (minutes: number, requestId: string, apps?: string[]) => Promise<unknown>;
  /** "Build context" for a focus item (clipboard) → what/connects/next card. */
  contextEnrich?: (focus: string, requestId: string) => Promise<unknown>;
  /** Optional direct burst-lane composer for /agent/enrich (never broadcasts cards). */
  agentLlmBrief?: (cwd: string) => Promise<string>;
  /** Runtime overlay-controlled gate for agentLlmBrief. */
  isAgentLlmBriefEnabled?: () => boolean;
  /** Chooser options: 5/15/30/60 with free coverage strings + available history. */
  windowCoverage?: () => unknown;
  /** Live coverage for an arbitrary N (the chooser slider). */
  windowCoverageAt?: (minutes: number) => unknown;
  /** Chooser context card: cached range summary + coverage. */
  windowPreview?: (minutes: number) => Promise<unknown>;
  /** "Call sinain": start a bridge voice session seeded with the last N minutes. */
  voiceStart?: (minutes: number, apps?: string[]) => Promise<{ ok: boolean; error?: string; loginUrl?: string }>;
  /** Distinct sources (apps + mic) in a range — the chooser's selection chips. */
  windowSources?: (minutes: number) => unknown;
  /** "Call sinain" via the deployed meetbot: bot joins the given Meet/Teams call. */
  voiceMeet?: (url: string, minutes: number) => Promise<{ ok: boolean; error?: string }>;
  /** End the running voice session (true if there was one). */
  voiceStop?: () => boolean;
  /** Store the pair-flow credential (session cookie or device token). */
  voicePair?: (cookie: string, token: string, email: string) => void;
  /** Current voice session state. */
  voiceStatus?: () => unknown;
  /** Seed for the webview call engine's meta datachannel. */
  voiceSeed?: () => { text: string; say: string };
  /** Proxy the call page's SDP offer to ARSinain with the stored credential. */
  voiceOffer?: (body: unknown) => Promise<{ status: number; body: string }>;
  /** Lifecycle events reported by the call page (live/ended/error);
   *  caption = a spoken line for the chip's live captions. */
  voiceEngineEvent?: (status: string, error?: string, caption?: string) => void;
  /** Set mic mute for the webview engine. */
  voiceMute?: (muted: boolean) => void;
  /** Control state the call page polls: {muted, end}. */
  voiceCtl?: () => { muted: boolean; end: boolean };

  /** Bare-agent announced its roster on startup. */
  registerBareAgent?: (available: string[], current: string) => void;
  /** Current per-lane agent choice; read by run.sh via the piggyback field
   *  on /escalation/pending and /spawn/pending responses, and by manual
   *  debug via GET /bareagent/config. `registered` distinguishes "user
   *  chose Off" (registered=true, lanes="") from "core forgot our
   *  registration" (registered=false) so run.sh heals only on the latter. */
  getBareAgentConfig?: () => { escalationAgent: string; terminalAgent: string; registered: boolean };
}

/** Clamp a save/summon range request to sane bounds (1 min … 8h). */
function clampMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(480, Math.round(n)));
}

/** Sanitize an app-selection list from a request body: strings only, capped.
 *  undefined (absent) means "no scope — everything included". */
function parseApps(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const apps = raw.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 32);
  return apps;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Pending spawn questions/permissions — resolve callbacks keyed by "ask:{taskId}" or "perm:{taskId}" */
const pendingSpawnQuestions = new Map<string, (answer: string) => void>();

// YOLO mode: "allow all permissions" until sinain-core restarts. Previously
// keyed on the openclaude session_id, but `claude -p ...` generates a fresh
// session_id every invocation, so the per-session YOLO never persisted across
// escalation calls and the user got prompted again on the very next tool use.
// A single process-global flag matches what users actually want from a YOLO
// button ("stop asking until I restart"), and is reset on every sinain-core
// start so it can't outlive a session unintentionally.
let yoloActive = false;
// Map permission-request id (perm-<ts>) -> session id it came from. Kept for
// debug/logging visibility into which agent invocation triggered YOLO.
const permissionToSession = new Map<string, string>();

export function createAppServer(deps: ServerDeps) {
  const { config, feedBuffer, senseBuffer, wsHandler } = deps;
  let senseInBytes = 0;
  const seenVisionCostIds = new Set<string>();
  const visionCostCleanup = setInterval(() => seenVisionCostIds.clear(), 60_000);

  // Browser origins allowed to call this localhost API cross-origin. A `*`
  // wildcard here would let ANY website drive /voice/pair, /capture/save,
  // /voice/start… from a drive-by tab (Chrome PNA opt-in included). Only two
  // browser contexts are legitimate: pages served by core itself (same-origin,
  // no CORS needed) and the ARSinain /hud/pair page posting the device token.
  const trustedOrigins = new Set<string>();
  try { trustedOrigins.add(new URL(config.voiceConfig.serverUrl).origin); } catch { /* not a URL */ }
  const corsOrigin = (req: IncomingMessage): string | null => {
    const origin = req.headers.origin;
    return origin && trustedOrigins.has(origin) ? origin : null;
  };

  const composeServerBrief = async (
    sessionId: string,
    cwd: string,
    mode: "full" | "refresh",
    composition: { seedText?: string; threadId?: string; knowledgeQuery?: string } = {},
  ): Promise<string> => deps.agentSessions
    ? composeEnrichBrief({
        registry: deps.agentSessions.registry,
        activeSessions: deps.agentSessions.activeSessions,
        sessionAssist: deps.agentSessions.sessionAssist,
        contextWindow: () => buildContextWindow(feedBuffer, senseBuffer, "standard", 10 * 60_000),
        searchEntities: deps.searchEntities,
      }, sessionId, cwd, mode, composition)
    : composition.seedText ?? "";

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const allowedOrigin = corsOrigin(req);
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (allowedOrigin) {
        // Chrome Private Network Access: the ARSinain /hud/pair page (public
        // https origin) POSTs the device token here (localhost) — the
        // preflight must opt in or Chrome blocks the request. Scoped to the
        // trusted origin only.
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${config.port}`);

    try {
      // ── /motion ── frame-rate scroll displacement (cheap; ungated). Shifts
      // live eyes by (dx,dy) so they glide with content between OCR ticks.
      if (req.method === "POST" && url.pathname === "/motion") {
        if (!deps.isScreenActive()) { res.end(JSON.stringify({ ok: true, gated: true })); return; }
        const body = await readBody(req, 8192);
        const d = JSON.parse(body);
        const dx = Number(d.dx), dy = Number(d.dy);
        const boxes: [number, number, number, number][] = Array.isArray(d.changed)
          ? d.changed.filter((b: any) => Array.isArray(b) && b.length === 4).slice(0, 16)
          : [];
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          deps.onMotion?.(dx, dy, boxes, String(d.app || ""), Number(d.display) || 0);
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /sense ──
      if (req.method === "POST" && url.pathname === "/sense") {
        if (!deps.isScreenActive()) {
          res.end(JSON.stringify({ ok: true, gated: true }));
          return;
        }
        const body = await readBody(req, MAX_SENSE_BODY);
        senseInBytes += Buffer.byteLength(body);
        deps.profiler?.gauge("network.senseInBytes", senseInBytes);
        const data = JSON.parse(body);

        // Record vision API cost before dedup — the call is already billed.
        // Dedup by cost_id to avoid double-counting on sender retries.
        const vc = data.vision_cost;
        if (vc && typeof vc.cost === "number" && vc.cost > 0) {
          const costId = vc.cost_id as string | undefined;
          if (!costId || !seenVisionCostIds.has(costId)) {
            if (costId) seenVisionCostIds.add(costId);
            deps.costTracker?.record({
              source: "vision",
              model: vc.model || "unknown",
              cost: vc.cost,
              tokensIn: vc.tokens_in || 0,
              tokensOut: vc.tokens_out || 0,
              ts: Date.now(),
            });
          }
        }
        if (!data.type || data.ts === undefined) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing type or ts" }));
          return;
        }
        // Extract image data from ROI if present
        const imageData = data.roi?.data || undefined;
        const imageBbox = data.roi?.bbox || undefined;
        const frameSize = Array.isArray(data.roi?.frame_size) ? data.roi.frame_size : undefined;
        const ocrLines = Array.isArray(data.ocr_lines) ? data.ocr_lines.slice(0, 40) : undefined;

        const event = senseBuffer.push({
          type: data.type,
          ts: data.ts,
          ocr: data.ocr || "",
          imageData,
          imageBbox,
          frameSize,
          ocrLines,
          meta: {
            ssim: data.meta?.ssim ?? 0,
            app: data.meta?.app || "unknown",
            windowTitle: data.meta?.windowTitle,
            screen: data.meta?.screen ?? 0,
          },
        });
        if (event) {
          log(TAG, `[sense] #${event.id} (${event.type}): app=${event.meta.app} ssim=${event.meta.ssim?.toFixed(3)}`);
          deps.onSenseEvent(event);
          res.end(JSON.stringify({ ok: true, id: event.id }));
        } else {
          // Event was deduplicated
          res.end(JSON.stringify({ ok: true, deduplicated: true }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/sense") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const metaOnly = url.searchParams.get("meta_only") === "true";
        const events = senseBuffer.query(after, metaOnly);
        res.end(JSON.stringify({ events, epoch: serverEpoch }));
        return;
      }

      // ── Deliberate capture: save / summon / enrich / coverage ──
      if (req.method === "POST" && url.pathname === "/capture/save") {
        if (!deps.captureSave) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "save unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as { minutes?: number; apps?: unknown };
        const minutes = clampMinutes(parsed.minutes);
        const saveId = deps.captureSave(minutes, parseApps(parsed.apps));
        res.end(JSON.stringify({ ok: true, saveId, minutes }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/capture/offer/response") {
        if (!deps.captureOfferResponse) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "offers unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as
          { offerId?: string; response?: string; minutes?: number; apps?: unknown };
        const RESPONSES = ["accepted", "adjusted", "dismissed", "expired"];
        if (!parsed.offerId || !parsed.response || !RESPONSES.includes(parsed.response)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "offerId + response(accepted|adjusted|dismissed|expired) required" }));
          return;
        }
        const result = deps.captureOfferResponse(
          parsed.offerId, parsed.response,
          typeof parsed.minutes === "number" ? parsed.minutes : undefined,
          parseApps(parsed.apps),
        );
        if (!result.ok) res.writeHead(410); // gone: unknown/expired offer
        res.end(JSON.stringify(result));
        return;
      }

      // Session Sense (DESIGN-SESSION-SENSE.md): nudge responses + session
      // actions. Both are consent gestures — every one becomes a label.
      if (req.method === "POST" && url.pathname === "/capture/session/response") {
        if (!deps.sessionNudgeResponse) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "session sense unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as
          { nudgeId?: string; response?: string; label?: string };
        const RESPONSES = ["tracked", "corrected", "dismissed", "expired"];
        if (!parsed.nudgeId || !parsed.response || !RESPONSES.includes(parsed.response)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "nudgeId + response(tracked|corrected|dismissed|expired) required" }));
          return;
        }
        const result = deps.sessionNudgeResponse(
          parsed.nudgeId, parsed.response,
          typeof parsed.label === "string" ? parsed.label.slice(0, 120) : undefined,
        );
        if (!result.ok) res.writeHead(410); // gone: unknown/expired nudge
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/capture/session/action") {
        if (!deps.sessionAction) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "session sense unavailable" }));
          return;
        }
        const body = await readBody(req, 4096);
        const parsed = JSON.parse(body || "{}") as { sessionId?: string; action?: string };
        const ACTIONS = ["wrapped", "keep_going", "ended", "later", "flag"];
        if (!parsed.sessionId || !parsed.action || !ACTIONS.includes(parsed.action)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "sessionId + action(wrapped|keep_going|ended|later|flag) required" }));
          return;
        }
        const result = deps.sessionAction(parsed.sessionId, parsed.action);
        if (!result.ok) res.writeHead(410);
        res.end(JSON.stringify(result));
        return;
      }

      // The bookmarked-session shelf (§9). ↗ share reuses the KG share
      // mechanic: each row resolves to its entity's wiki page when the KG
      // knows the thread by name — the share affordances live there.
      if (req.method === "GET" && url.pathname === "/capture/session/bookmarks") {
        if (!deps.sessionBookmarks) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "session sense unavailable" }));
          return;
        }
        const rows = deps.sessionBookmarks();
        if (deps.searchEntities) {
          await Promise.all(rows.map(async (row) => {
            try {
              const found = await deps.searchEntities!(row.label, 1) as { results?: { entity?: string }[] };
              const entity = found?.results?.[0]?.entity;
              if (entity) {
                const slug = entity.replace(/^entity:/, "");
                row.kgPath = `/knowledge/ui/entity/${encodeURIComponent(slug)}`;
              }
            } catch { /* unresolved — the row ships without a kgPath */ }
          }));
        }
        res.end(JSON.stringify({
          ok: true,
          bookmarks: rows,
          // The sessions list leads with what's being tracked right now —
          // possibly several in parallel (§5: one warm, the rest paused).
          sessions: deps.sessionActive?.() ?? [],
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/capture/session/bookmark") {
        if (!deps.sessionBookmarkAction) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "session sense unavailable" }));
          return;
        }
        const body = await readBody(req, 4096);
        const parsed = JSON.parse(body || "{}") as { threadId?: string; action?: string };
        if (!parsed.threadId || !parsed.action || !["resume", "remove"].includes(parsed.action)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "threadId + action(resume|remove) required" }));
          return;
        }
        const result = deps.sessionBookmarkAction(parsed.threadId, parsed.action);
        if (!result.ok) res.writeHead(410);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/capture/undo") {
        const body = await readBody(req, 4096);
        const { saveId } = JSON.parse(body || "{}") as { saveId?: string };
        if (!saveId || !deps.captureUndo) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "saveId required" }));
          return;
        }
        const undone = deps.captureUndo(saveId);
        res.end(JSON.stringify({ ok: true, undone }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/capture/retry") {
        const body = await readBody(req, 4096);
        const { saveId } = JSON.parse(body || "{}") as { saveId?: string };
        if (!saveId || !deps.captureRetry) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "saveId required" }));
          return;
        }
        const retried = deps.captureRetry(saveId);
        res.end(JSON.stringify({ ok: true, retried }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/context/summon") {
        if (!deps.contextSummon) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "burst lane unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as { minutes?: number; apps?: unknown };
        const minutes = clampMinutes(parsed.minutes);
        const requestId = `summon-${Date.now().toString(36)}`;
        // Respond immediately; the brief card flows to the overlay via WS.
        res.end(JSON.stringify({ ok: true, requestId, minutes }));
        void deps.contextSummon(minutes, requestId, parseApps(parsed.apps));
        return;
      }

      if (req.method === "POST" && url.pathname === "/context/enrich") {
        if (!deps.contextEnrich) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "burst lane unavailable" }));
          return;
        }
        const body = await readBody(req, 65536);
        const focus = String((JSON.parse(body || "{}") as { text?: string }).text ?? "").trim();
        if (!focus) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "text required (clipboard is empty?)" }));
          return;
        }
        const requestId = `enrich-${Date.now().toString(36)}`;
        res.end(JSON.stringify({ ok: true, requestId }));
        void deps.contextEnrich(focus, requestId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/window/preview") {
        const minutes = clampMinutes(Number(url.searchParams.get("minutes") ?? 30));
        res.end(JSON.stringify({ ok: true, preview: (await deps.windowPreview?.(minutes)) ?? null }));
        return;
      }

      // Sources (apps + mic) present in a range — the chooser's app-selection
      // chips. Free (window titles only), no LLM.
      if (req.method === "GET" && url.pathname === "/window/sources") {
        const minutes = clampMinutes(parseInt(url.searchParams.get("minutes") || "30", 10));
        res.end(JSON.stringify({ ok: true, minutes, sources: deps.windowSources?.(minutes) ?? [] }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/window/coverage") {
        // ?minutes=N → single live coverage row for the chooser's slider.
        const minutesParam = url.searchParams.get("minutes");
        if (minutesParam !== null) {
          res.end(JSON.stringify({
            ok: true,
            option: deps.windowCoverageAt?.(clampMinutes(Number(minutesParam))) ?? null,
          }));
          return;
        }
        res.end(JSON.stringify({ ok: true, options: deps.windowCoverage?.() ?? [] }));
        return;
      }

      // ── Voice sessions ("Talk to Sinain" via the AR bridge) ──
      if (req.method === "POST" && url.pathname === "/voice/start") {
        if (!deps.voiceStart) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "voice unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as { minutes?: number; apps?: unknown };
        // 0 = unseeded session; otherwise clamp like every range gesture.
        const minutes = parsed.minutes === 0 ? 0 : clampMinutes(parsed.minutes);
        const result = await deps.voiceStart(minutes, parseApps(parsed.apps));
        if (!result.ok) res.writeHead(409);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/voice/meet") {
        if (!deps.voiceMeet) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "voice unavailable" }));
          return;
        }
        const body = await readBody(req, 8192);
        const parsed = JSON.parse(body || "{}") as { url?: string; minutes?: number };
        const meetUrl = String(parsed.url ?? "").trim();
        if (!/^https:\/\/(meet\.google\.com|teams\.live\.com|teams\.microsoft\.com)\//i.test(meetUrl)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "url must be a Google Meet or Teams link" }));
          return;
        }
        const minutes = parsed.minutes === 0 ? 0 : clampMinutes(parsed.minutes);
        const result = await deps.voiceMeet(meetUrl, minutes);
        if (!result.ok) res.writeHead(502);
        res.end(JSON.stringify(result));
        return;
      }

      // Browser pairing callback — the /hud/pair page on the deployed server
      // POSTs the freshly-minted device token here after the user logs in.
      if (req.method === "POST" && url.pathname === "/voice/pair") {
        // Credential-bearing endpoint: a browser request must come from the
        // trusted pairing origin. Non-browser callers send no Origin header.
        if (req.headers.origin && !corsOrigin(req)) {
          res.writeHead(403);
          res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
          return;
        }
        const body = await readBody(req, 4096);
        const { cookie, token, email } = JSON.parse(body || "{}") as
          { cookie?: string; token?: string; email?: string };
        if ((!cookie && !token) || !deps.voicePair) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "cookie or token required" }));
          return;
        }
        deps.voicePair(cookie ?? "", token ?? "", email ?? "");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/voice/stop") {
        res.end(JSON.stringify({ ok: true, stopped: deps.voiceStop?.() ?? false }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/voice/status") {
        res.end(JSON.stringify({ ok: true, ...(deps.voiceStatus?.() ?? { status: "unavailable" }) }));
        return;
      }

      // ── Hidden-webview call engine (browser WebRTC stack) ──
      // The overlay's invisible WKWebView loads this page; it talks back to
      // core only (same origin) — core proxies signaling with the paired
      // device token so the page never holds a credential.
      if (req.method === "GET" && url.pathname === "/voice/call.html") {
        try {
          const page = readFileSync(
            resolvePathJoin(dirname(fileURLToPath(import.meta.url)), "..", "static", "voice-call.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(page);
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: "call page missing" }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/voice/frame") {
        try {
          // Async read — this is polled 4×/s by the call engine; readFileSync
          // here would block the event loop on every frame.
          const jpeg = await readFile(config.voiceConfig.framePath);
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
          res.end(jpeg);
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: "no frame — is sck-capture running?" }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/voice/seed") {
        res.end(JSON.stringify(deps.voiceSeed?.() ?? { text: "", say: "" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/voice/turn") {
        try {
          const r = await fetch(config.voiceConfig.turnUrl, { signal: AbortSignal.timeout(5_000) });
          res.writeHead(r.status, { "Content-Type": "application/json" });
          res.end(await r.text());
        } catch {
          res.end(JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/voice/offer") {
        if (!deps.voiceOffer) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "voice unavailable" }));
          return;
        }
        const body = await readBody(req, 262_144); // SDP offers run large
        try {
          const result = await deps.voiceOffer(JSON.parse(body || "{}"));
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(result.body);
        } catch (err) {
          res.writeHead(502);
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err).slice(0, 200) }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/voice/engine") {
        const body = await readBody(req, 8192);
        const { status, error, caption } = JSON.parse(body || "{}") as
          { status?: string; error?: string; caption?: string };
        if (status) deps.voiceEngineEvent?.(status, error, caption?.slice(0, 500));
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Mic mute + hangup control for the webview engine (page polls ctl).
      if (req.method === "POST" && url.pathname === "/voice/mute") {
        const body = await readBody(req, 1024);
        const { muted } = JSON.parse(body || "{}") as { muted?: boolean };
        deps.voiceMute?.(muted === true);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/voice/ctl") {
        res.end(JSON.stringify(deps.voiceCtl?.() ?? { muted: false, end: false }));
        return;
      }

      // ── /sense/context (structured semantic context) ──
      if (req.method === "GET" && url.pathname === "/sense/context") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 50);
        const includeDeltas = url.searchParams.get("include_deltas") === "true";
        const includeSummary = url.searchParams.get("include_summary") !== "false";
        const context = senseBuffer.getStructuredContext({
          limit,
          includeDeltas,
          includeSummary,
        });
        res.end(JSON.stringify({ ok: true, context, epoch: serverEpoch }));
        return;
      }

      // ── /sense/activity (activity breakdown) ──
      if (req.method === "GET" && url.pathname === "/sense/activity") {
        const since = parseInt(url.searchParams.get("since") || "0");
        const breakdown = senseBuffer.getActivityBreakdown(since);
        res.end(JSON.stringify({
          ok: true,
          activity: senseBuffer.latestActivity(),
          breakdown,
          epoch: serverEpoch,
        }));
        return;
      }

      // ── /sense/deltas (accumulated deltas) ──
      if (req.method === "GET" && url.pathname === "/sense/deltas") {
        const flush = url.searchParams.get("flush") === "true";
        const deltas = senseBuffer.getAccumulatedDeltas(flush);
        res.end(JSON.stringify({ ok: true, deltas, count: deltas.length }));
        return;
      }

      // ── /feed ──
      if (req.method === "GET" && url.pathname === "/feed") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const items = feedBuffer.query(after);
        res.end(JSON.stringify({ messages: items, epoch: serverEpoch }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/feed") {
        const body = await readBody(req, 65536);
        const { text, priority } = JSON.parse(body);
        deps.onFeedPost(text, priority || "normal");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /region/:id/task — composed context for terminal-mode ROI runs ──
      if (req.method === "GET" && url.pathname.startsWith("/region/") && url.pathname.endsWith("/task")) {
        const regionId = url.pathname.slice("/region/".length, -"/task".length);
        const seed = (await deps.getRegionTask?.(regionId)) ?? null;
        if (!seed) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "unknown region" }));
          return;
        }
        const sess = deps.getThreadSession?.(regionId);
        // sessionId deliberately empty: the ROI composition must be identical
        // whether pulled here or via /roi/pending?enriched=1 (sinain_roi MCP).
        const text = await composeServerBrief(
          "",
          "",
          "full",
          { seedText: seed.text, threadId: regionId, knowledgeQuery: seed.text },
        );
        // `text` kept for back-compat; `roiSeedId` is the unified pull handle —
        // the terminal can `sinain_roi(id)` instead of embedding the text.
        res.end(JSON.stringify({ ok: true, text, roiSeedId: seed.id, ...(sess ?? {}) }));
        return;
      }

      // ── /handoff/:key — one-shot pending handoff transcript block ──
      // MAIN interactive terminals have no ROI seed to fold the transcript
      // into, so they pull it here and prepend it to the digest task.
      if (req.method === "GET" && url.pathname.startsWith("/handoff/")) {
        const key = decodeURIComponent(url.pathname.slice("/handoff/".length));
        const block = deps.getHandoffBlock?.(key) ?? "";
        res.end(JSON.stringify({ ok: true, block }));
        return;
      }

      // ── POST /seed — portable seed text for the clipboard "copy seed" ──
      // Body: { key: regionId|"main"|"clipboard", transcript?, focus? }.
      // Returns the composed context as plain text (knowledge inlined, header +
      // transcript folded in) for pasting into an agent we don't integrate with.
      // `focus` (clipboard enrichment) treats arbitrary text as a pseudo-ROI:
      // the seed is the situational digest + KG retrieved against that text.
      if (req.method === "POST" && url.pathname === "/seed") {
        const body = await readBody(req, 256 * 1024);
        let key = "";
        let transcript: string | undefined;
        let focus: string | undefined;
        try {
          const d = JSON.parse(body);
          key = String(d.key ?? "").trim();
          if (d.transcript) transcript = String(d.transcript);
          if (d.focus) focus = String(d.focus);
        } catch { /* bad body */ }
        if (!key || !deps.buildSeed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "missing key or handler" }));
          return;
        }
        const text = await deps.buildSeed(key, transcript, focus);
        if (text === null) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "unknown thread" }));
          return;
        }
        res.end(JSON.stringify({ ok: true, text }));
        return;
      }

      // ── POST /roi-seed — mint a seed from arbitrary text, return its id ──
      // The unified MCP-pull mechanic for any non-region context (MAIN digest,
      // fallbacks): the terminal seeds via sinain_roi(id), never a file.
      if (req.method === "POST" && url.pathname === "/roi-seed") {
        const body = await readBody(req, 64 * 1024);
        let text = "";
        try { text = String(JSON.parse(body).text ?? ""); } catch { /* empty */ }
        if (!text.trim() || !deps.mintRoiSeed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "missing text or handler" }));
          return;
        }
        res.end(JSON.stringify({ ok: true, id: deps.mintRoiSeed(text) }));
        return;
      }

      // ── /agent ──
      if (req.method === "POST" && url.pathname === "/agent/context-note") {
        const body = await readBody(req, 4 * 1024);
        let sessionId = "";
        let text = "";
        try {
          const parsed = JSON.parse(body);
          sessionId = String(parsed.session_id ?? "").trim();
          text = String(parsed.text ?? "").trim().slice(0, 1200);
        } catch { /* bad body */ }
        if (!sessionId || !text || !deps.agentSessions) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "missing session_id, text, or agent sessions" }));
          return;
        }
        if (!deps.agentSessions.registry.queueContextNote(sessionId, text)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "live agent session not found" }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/enrich") {
        if (config.agentEnrichEnabled === false) {
          res.end(JSON.stringify({ ok: true, brief: "" }));
          return;
        }
        const sessionId = url.searchParams.get("session_id") || "";
        const cwd = url.searchParams.get("cwd") || "";
        if (url.searchParams.get("mode") === "facts") {
          const lines = deps.agentSessions
            ? deps.agentSessions.registry.consumeFactLines(
                sessionId,
                deps.agentSessions.factLinesSince ?? (() => []),
              )
            : [];
          res.end(JSON.stringify({ ok: true, brief: lines.join("\n").slice(0, 1200).trimEnd() }));
          return;
        }
        const mode = url.searchParams.get("mode") === "refresh" ? "refresh" : "full";
        let brief = await composeServerBrief(sessionId, cwd, mode);
        if (mode === "full" && brief && deps.agentLlmBrief && deps.isAgentLlmBriefEnabled?.()) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const cardText = await Promise.race([
              deps.agentLlmBrief(cwd),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("agent LLM brief timeout")), 6_500);
              }),
            ]);
            brief = appendBuildContextBrief(brief, cardText);
          } catch { /* optional context: deterministic brief still returns */
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
        res.end(JSON.stringify({ ok: true, brief }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/event") {
        if (!deps.agentSessions) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "agent sessions unavailable" }));
          return;
        }
        let frame: AgentEventFrame;
        try {
          frame = JSON.parse(await readBody(req, 65_536)) as AgentEventFrame;
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
          return;
        }
        if (typeof frame.session_id !== "string" || typeof frame.hook_event_name !== "string") {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing session_id or hook_event_name" }));
          return;
        }
        deps.agentSessions.registry.handleEvent(frame);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/approve") {
        if (!deps.agentSessions) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "agent sessions unavailable" }));
          return;
        }
        let frame: AgentEventFrame;
        try {
          frame = JSON.parse(await readBody(req, 65_536)) as AgentEventFrame;
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
          return;
        }
        if (typeof frame.session_id !== "string" || typeof frame.hook_event_name !== "string") {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing session_id or hook_event_name" }));
          return;
        }
        req.setTimeout(0);
        const { registry, approvals } = deps.agentSessions;
        registry.handleEvent(frame);
        const approval = approvals.create(frame, config.agentApproveTimeoutMs);
        const request = approvals.get(approval.id)!;
        registry.markWaiting(frame.session_id, request.command);
        wsHandler.broadcastRaw({ type: "agent_approval", request });

        let settled = false;
        let clientClosed = false;
        res.on("close", () => {
          if (settled) return;
          clientClosed = true;
          if (!approvals.cancel(approval.id)) return;
          registry.finishApproval(request.sessionId, "ask", request.command);
          wsHandler.broadcastRaw({ type: "agent_approval_resolved", id: approval.id, behavior: "ask" });
        });
        const decision = await approval.promise;
        settled = true;
        if (decision.behavior === "ask" && !clientClosed) {
          wsHandler.broadcastRaw({ type: "agent_approval_resolved", id: approval.id, behavior: "ask" });
        }
        if (!res.destroyed) res.end(JSON.stringify(decision));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/sessions") {
        if (!deps.agentSessions) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "agent sessions unavailable" }));
          return;
        }
        const sessions = deps.agentSessions.registry.snapshot();
        res.end(JSON.stringify({ sessions, ...deps.agentSessions.registry.counts() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/digest") {
        res.end(JSON.stringify({ ok: true, digest: deps.getAgentDigest() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/history") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 50);
        res.end(JSON.stringify({ ok: true, results: deps.getAgentHistory(limit) }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/context") {
        res.end(JSON.stringify({ ok: true, context: deps.getAgentContext() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/config") {
        res.end(JSON.stringify({ ok: true, config: deps.getAgentConfig() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/config") {
        const body = await readBody(req, 4096);
        const updates = JSON.parse(body);
        const result = deps.updateAgentConfig(updates);
        res.end(JSON.stringify({ ok: true, config: result }));
        return;
      }

      // ── /knowledge ──
      // ── sinain wiki — the virtual vault as markdown (DESIGN-SINAIN-WIKI) ──
      // File-shaped .md paths + the vault zip export. Handled before the
      // legacy JSON routes; both generations coexist on /knowledge/*.
      if (await handleWikiRoute(req, res, url, deps)) return;

      if (req.method === "GET" && url.pathname === "/knowledge") {
        // Return portable knowledge document
        const knowledgePath = deps.getKnowledgeDocPath?.();
        if (knowledgePath) {
          try {
            const { readFileSync } = await import("node:fs");
            const content = readFileSync(knowledgePath, "utf-8");
            res.end(JSON.stringify({ ok: true, content }));
          } catch {
            res.end(JSON.stringify({ ok: true, content: "" }));
          }
        } else {
          res.end(JSON.stringify({ ok: true, content: "" }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/knowledge/facts") {
        // Query knowledge graph for entity-matched facts
        const entitiesParam = url.searchParams.get("entities") || "";
        const maxFacts = Math.min(parseInt(url.searchParams.get("max") || "5"), 20);
        const entities = entitiesParam.split(",").map(e => e.trim()).filter(Boolean);

        if (deps.queryKnowledgeFacts) {
          try {
            const facts = await deps.queryKnowledgeFacts(entities, maxFacts);
            res.end(JSON.stringify({ ok: true, facts }));
          } catch (err) {
            res.end(JSON.stringify({ ok: true, facts: [], error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: true, facts: [] }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/knowledge/entities") {
        // List all entities in the knowledge graph
        const max = Math.min(parseInt(url.searchParams.get("max") || "50"), 1000);
        if (deps.listKnowledgeEntities) {
          try {
            const entities = await deps.listKnowledgeEntities(max);
            res.end(JSON.stringify({ ok: true, entities }));
          } catch (err) {
            res.end(JSON.stringify({ ok: true, entities: [], error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: true, entities: [] }));
        }
        return;
      }

      // ── /knowledge/as-of — bi-temporal entity query ──
      if (req.method === "GET" && url.pathname === "/knowledge/as-of") {
        const entity = url.searchParams.get("entity") || "";
        const date = url.searchParams.get("date") || "";
        if (!entity || !date) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "entity and date params required" }));
          return;
        }
        if (deps.queryKnowledgeAsOf) {
          try {
            const result = await deps.queryKnowledgeAsOf(entity, date);
            res.end(JSON.stringify({ ok: true, entity, date, attributes: JSON.parse(result) }));
          } catch (err) {
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: false, error: "bi-temporal query not available" }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/knowledge/export") {
        // Export knowledge module (filterable by domain)
        const domain = url.searchParams.get("domain") || null;
        const max = Math.min(parseInt(url.searchParams.get("max") || "100"), 500);
        if (deps.exportKnowledge) {
          try {
            const data = await deps.exportKnowledge(domain, max);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="sinain-knowledge-${domain || "all"}.json"`);
            res.end(data);
          } catch (err) {
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: false, error: "export not available" }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/knowledge/import") {
        // Import knowledge module
        const body = await readBody(req, 1_000_000); // 1MB max
        if (deps.importKnowledge) {
          try {
            const result = await deps.importKnowledge(body);
            res.end(result);
          } catch (err) {
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: false, error: "import not available" }));
        }
        return;
      }

      // ── /memory/episodes ── T1 episodic tier via memoryd (DESIGN-MEMORY-V2
      // P1): raw dated episode windows — recent-dialogue recall that is not
      // distillation-dependent and not capped by the feed ring.
      if (req.method === "GET" && url.pathname === "/memory/episodes") {
        const payload = JSON.stringify({
          op: "episodes",
          query: url.searchParams.get("q") || "",
          since: url.searchParams.get("since") || "",
          until: url.searchParams.get("until") || "",
          limit: Math.min(parseInt(url.searchParams.get("limit") || "20"), 100),
          include_text: url.searchParams.get("text") === "1",
        }) + "\n";
        try {
          const { connect } = await import("node:net");
          const sockPath = process.env.SINAIN_KG_SOCK || "/tmp/sinain-kg.sock";
          const result = await new Promise<string>((resolvP, rejectP) => {
            const sock = connect(sockPath);
            let buf = "";
            sock.setTimeout(5000, () => { sock.destroy(); rejectP(new Error("memoryd timeout")); });
            sock.on("error", rejectP);
            sock.on("connect", () => sock.write(payload));
            sock.on("data", (d) => {
              buf += d.toString();
              const nl = buf.indexOf("\n");
              if (nl >= 0) { sock.destroy(); resolvP(buf.slice(0, nl)); }
            });
          });
          const parsed = JSON.parse(result);
          res.end(JSON.stringify({ ok: !parsed.error, ...parsed }));
        } catch (err) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: `memoryd unavailable: ${String(err)}` }));
        }
        return;
      }

      // ── /knowledge/query ── (combined entity recall — used by topic page) ──
      if (req.method === "GET" && url.pathname === "/knowledge/query") {
        const q = url.searchParams.get("q") || "";
        const maxFacts = Math.min(parseInt(url.searchParams.get("max") || "20"), 50);
        if (!q.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "q parameter required" }));
          return;
        }
        // Split query into entity keywords for queryKnowledgeFacts
        const entities = q.trim().split(/[\s,+]+/).filter(Boolean);
        if (deps.queryKnowledgeFacts) {
          try {
            const factsText = await deps.queryKnowledgeFacts(entities, maxFacts);
            res.end(JSON.stringify({ ok: true, query: q, facts_text: factsText, entities }));
          } catch (err) {
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        } else {
          res.end(JSON.stringify({ ok: true, query: q, facts_text: "", entities }));
        }
        return;
      }

      // ── /knowledge/search ── (entity-prioritized) ──
      if (req.method === "GET" && url.pathname === "/knowledge/search") {
        const q = url.searchParams.get("q") || "";
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
        if (!q.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "q parameter required" }));
          return;
        }
        if (!deps.searchEntities) {
          res.end(JSON.stringify({ ok: true, results: [], topic_fallback: true }));
          return;
        }
        try {
          const result = await deps.searchEntities(q, limit) as any;
          // Telemetry
          if (deps.webDb) {
            const top = result.results?.[0]?.entity ?? null;
            deps.webDb.logSearch(q, top, result.results?.length ?? 0);
          }
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/page ── (LLM-rendered Confluence-style page) ──
      if (req.method === "GET" && url.pathname === "/knowledge/page") {
        const entity = url.searchParams.get("entity") || "";
        const refresh = url.searchParams.get("refresh") === "1";
        const maxFacts = Math.min(parseInt(url.searchParams.get("max_facts") || "1000"), 5000);
        if (!entity) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "entity parameter required" }));
          return;
        }
        if (!deps.renderEntityPage) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "page renderer not available" }));
          return;
        }
        try {
          const page = await deps.renderEntityPage(entity, { refresh, maxFacts });
          // Touch bookmark visit (auto-populates 'recent')
          if (deps.webDb) deps.webDb.touchVisit(entity);
          res.end(JSON.stringify({ ok: true, ...(page as object) }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/graph/children ── (lazy tree expansion) ──
      if (req.method === "GET" && url.pathname === "/knowledge/graph/children") {
        const entity = url.searchParams.get("entity") || "";
        if (!entity) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "entity parameter required" }));
          return;
        }
        if (!deps.graphChildren) {
          res.end(JSON.stringify({ ok: true, entity, groups: [] }));
          return;
        }
        try {
          const result = await deps.graphChildren(entity);
          res.end(JSON.stringify({ ok: true, ...(result as object) }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/bookmarks ──
      if (req.method === "GET" && url.pathname === "/knowledge/bookmarks") {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        const status = url.searchParams.get("status") as BookmarkStatus | null;
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
        if (status && !["favorite","archive","recent"].includes(status)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "status must be favorite|archive|recent" }));
          return;
        }
        const bookmarks = deps.webDb.listBookmarks(status ?? undefined, limit);
        res.end(JSON.stringify({ ok: true, bookmarks }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/knowledge/bookmarks") {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        const body = await readBody(req, 16_384);
        let payload: { entity?: string; status?: string; note?: string };
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        const entity = (payload.entity || "").trim();
        const status = payload.status as BookmarkStatus | undefined;
        if (!entity) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "entity required" }));
          return;
        }
        if (!status || !["favorite","archive","recent"].includes(status)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "status must be favorite|archive|recent" }));
          return;
        }
        const bookmark = deps.webDb.upsertBookmark(entity, status, payload.note);
        res.end(JSON.stringify({ ok: true, bookmark }));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/knowledge/bookmarks/")) {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        const entity = decodeURIComponent(url.pathname.slice("/knowledge/bookmarks/".length));
        if (!entity) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "entity required in path" }));
          return;
        }
        const removed = deps.webDb.deleteBookmark(entity);
        res.end(JSON.stringify({ ok: true, removed }));
        return;
      }

      // ── /knowledge/concepts/export ──
      if (req.method === "GET" && url.pathname === "/knowledge/concepts/export") {
        const entity = url.searchParams.get("entity") || "";
        const depth = Math.min(parseInt(url.searchParams.get("depth") || "1"), 3);
        const includeRetracted = url.searchParams.get("include_retracted") === "1";
        const includePage = url.searchParams.get("include_page") !== "0";
        const redactRules = (url.searchParams.get("redact")
          || "private,creditcard,apikey,bearer,awskey,password,secret")
          .split(",").map(s => s.trim()).filter(Boolean);
        if (!entity) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "entity parameter required" }));
          return;
        }
        if (!deps.exportConcept) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "concept export not available" }));
          return;
        }
        try {
          const bundle = await deps.exportConcept(entity, depth, {
            includeRetracted, includePage, redactRules,
          });
          // Sanitize entity for filename
          const slug = entity.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").slice(0, 60);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Disposition", `attachment; filename="${slug}.sinain-concept.json"`);
          res.end(JSON.stringify(bundle, null, 2));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/concepts/import ──
      if (req.method === "POST" && url.pathname === "/knowledge/concepts/import") {
        const conflict = (url.searchParams.get("conflict") || "merge") as "skip"|"merge"|"overwrite";
        if (!["skip","merge","overwrite"].includes(conflict)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "conflict must be skip|merge|overwrite" }));
          return;
        }
        if (!deps.importConcept) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "concept import not available" }));
          return;
        }
        // Allow large bundles (up to ~50MB).
        const body = await readBody(req, 50 * 1024 * 1024);
        let envelope: unknown;
        try { envelope = JSON.parse(body); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        try {
          const result = await deps.importConcept(envelope, conflict);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/lint/apply ── bulk-retract lint findings (wiki lint page).
      // Report side is the wiki page GET /knowledge/lint.md.
      if (req.method === "POST" && url.pathname === "/knowledge/lint/apply") {
        if (!deps.lintKnowledge) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "lint not available" }));
          return;
        }
        try {
          const aggressive = url.searchParams.get("aggressive") === "1";
          const result = await deps.lintKnowledge(true, aggressive) as any;
          // Findings list is large and the UI only needs the totals here.
          res.end(JSON.stringify({
            ok: true, applied: result?.applied ?? 0, counts: result?.counts ?? {},
          }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err).slice(0, 300) }));
        }
        return;
      }

      // ── /knowledge/facts/:id (DELETE = retract, POST .../restore = restore) ──
      if (req.method === "DELETE" && url.pathname.startsWith("/knowledge/facts/")
          && !url.pathname.endsWith("/restore")) {
        const factId = decodeURIComponent(url.pathname.slice("/knowledge/facts/".length));
        if (!factId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "fact id required in path" }));
          return;
        }
        if (!deps.retractFact) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "retraction not available" }));
          return;
        }
        let body: any = {};
        if (parseInt(req.headers["content-length"] || "0") > 0) {
          try { body = JSON.parse(await readBody(req, 4096)); } catch {}
        }
        const reason = (body.reason || "").toString().slice(0, 500) || null;
        const actor = (body.actor || "web-ui").toString().slice(0, 80) || null;
        const sourceEntity = (body.source_entity || "").toString().slice(0, 200) || null;
        try {
          const result = await deps.retractFact(factId, reason, actor, sourceEntity);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/knowledge/facts/")
          && url.pathname.endsWith("/restore")) {
        const factId = decodeURIComponent(
          url.pathname.slice("/knowledge/facts/".length, -"/restore".length),
        );
        if (!factId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "fact id required in path" }));
          return;
        }
        if (!deps.restoreFact) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "restore not available" }));
          return;
        }
        let body: any = {};
        try { body = JSON.parse(await readBody(req, 4096)); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        const undoToken = (body.undo_token || "").toString();
        if (!undoToken) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "undo_token required" }));
          return;
        }
        try {
          // Python owns the retraction tx + audit log update — TS just relays.
          const result = await deps.restoreFact(factId, undoToken);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      // ── /knowledge/shares ── (cross-machine concept share metadata) ──
      if (req.method === "POST" && url.pathname === "/knowledge/shares") {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        let body: any;
        try { body = JSON.parse(await readBody(req, 16_384)); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
          return;
        }
        const required = ["entity_id", "mode", "share_token", "url"];
        for (const k of required) {
          if (!body[k] || typeof body[k] !== "string") {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: `${k} required` }));
            return;
          }
        }
        if (!["fragment", "peer"].includes(body.mode)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "mode must be fragment|peer" }));
          return;
        }
        try {
          const row = deps.webDb.createSharedDoc({
            share_token: body.share_token,
            entity_id: body.entity_id,
            mode: body.mode,
            // Fragment shares are 'delivered' the moment the link is created
            // (the bundle is in the URL); peer shares start as 'waiting'.
            status: body.mode === "fragment" ? "delivered" : "waiting",
            bundle_size: typeof body.bundle_size === "number" ? body.bundle_size : null,
            url: body.url,
            delivered_at: body.mode === "fragment" ? Date.now() : null,
            revoked_at: null,
            recipient_hint: null,
            notes: body.notes || null,
          });
          res.end(JSON.stringify({ ok: true, share: row }));
        } catch (err: any) {
          // Most likely UNIQUE constraint on share_token
          res.writeHead(409);
          res.end(JSON.stringify({ ok: false, error: err.message?.slice(0, 200) }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/knowledge/shares") {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        // Auto-expire stale shares opportunistically on each list call.
        const ttlHours = parseInt(process.env.SINAIN_SHARE_TTL_HOURS || "24");
        if (ttlHours > 0) {
          deps.webDb.expireStaleShares(ttlHours * 60 * 60 * 1000);
        }
        const statusParams = url.searchParams.getAll("status").filter(Boolean);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
        const includeArchived = url.searchParams.get("include_archived") === "1";
        const shares = deps.webDb.listSharedDocs({
          statuses: statusParams.length > 0 ? statusParams as any : undefined,
          limit,
          includeArchived,
        });
        const activeCount = deps.webDb.countActiveShares();
        res.end(JSON.stringify({ ok: true, shares, active_count: activeCount }));
        return;
      }

      if (req.method === "PATCH" && url.pathname.startsWith("/knowledge/shares/")) {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        const token = decodeURIComponent(url.pathname.slice("/knowledge/shares/".length));
        if (!token) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "share_token required" }));
          return;
        }
        let body: any;
        try { body = JSON.parse(await readBody(req, 4096)); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
          return;
        }
        const status = body.status;
        const valid = ["waiting","connecting","delivered","disconnected","revoked","expired"];
        if (!status || !valid.includes(status)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: `status must be one of ${valid.join("|")}` }));
          return;
        }
        const ok = deps.webDb.updateSharedDocStatus(token, status, {
          delivered_at: typeof body.delivered_at === "number" ? body.delivered_at : undefined,
          revoked_at: typeof body.revoked_at === "number" ? body.revoked_at : undefined,
          recipient_hint: typeof body.recipient_hint === "string" ? body.recipient_hint.slice(0, 200) : undefined,
        });
        if (!ok) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: "share not found" }));
          return;
        }
        res.end(JSON.stringify({ ok: true, share: deps.webDb.getSharedDoc(token) }));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/knowledge/shares/")) {
        if (!deps.webDb) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: "web.db not initialized" }));
          return;
        }
        const token = decodeURIComponent(url.pathname.slice("/knowledge/shares/".length));
        const removed = deps.webDb.deleteSharedDoc(token);
        res.end(JSON.stringify({ ok: true, removed }));
        return;
      }

      // Legacy fact-browser kept for fallback / quick raw access.
      if (req.method === "GET" && url.pathname === "/knowledge/ui-legacy") {
        res.setHeader("Content-Type", "text/html");
        res.end(KNOWLEDGE_UI_HTML);
        return;
      }

      // Sinain Wiki SPA — router + markdown renderer over the virtual vault
      // (replaces the Living Confluence UI; docs/DESIGN-SINAIN-WIKI.md §6).
      // Cache-Control: no-cache forces browsers to revalidate the SPA HTML
      // on every navigation. Otherwise, after a sinain-core upgrade the
      // browser serves stale SPA from cache (bugfixes don't take effect
      // until the user hard-reloads). With revalidation on, ETag mismatches
      // are detected immediately and the new SPA is loaded.
      if (req.method === "GET"
          && (url.pathname === "/knowledge/ui" || url.pathname.startsWith("/knowledge/ui/"))) {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
        res.end(renderWikiUi());
        return;
      }

      // ── /traces ──
      if (req.method === "GET" && url.pathname === "/traces") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
        res.end(JSON.stringify({ traces: deps.getTraces(after, limit) }));
        return;
      }

      // ── /profiling/sense ──
      if (req.method === "POST" && url.pathname === "/profiling/sense") {
        const body = await readBody(req, 4096);
        deps.onSenseProfile(JSON.parse(body));
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /learning/feedback ──
      if (req.method === "GET" && url.pathname === "/learning/feedback") {
        if (!deps.feedbackStore) {
          res.end(JSON.stringify({ ok: false, error: "learning disabled" }));
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
        const records = deps.feedbackStore.queryRecent(limit);
        res.end(JSON.stringify({ ok: true, records, count: records.length }));
        return;
      }

      // ── /learning/stats ──
      if (req.method === "GET" && url.pathname === "/learning/stats") {
        if (!deps.feedbackStore) {
          res.end(JSON.stringify({ ok: false, error: "learning disabled" }));
          return;
        }
        const stats = deps.feedbackStore.getStats();
        res.end(JSON.stringify({ ok: true, ...stats }));
        return;
      }

      // ── /reconnect-gateway ──
      if (req.method === "POST" && url.pathname === "/reconnect-gateway") {
        deps.reconnectGateway();
        res.end(JSON.stringify({ ok: true, message: "gateway reconnection initiated" }));
        return;
      }

      // ── /embed ── (used by knowledge_integrator.py and graph_query.py)
      if (req.method === "POST" && url.pathname === "/embed") {
        if (!deps.embedTexts || !deps.isEmbeddingReady?.()) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "embedding model loading" }));
          return;
        }
        let body = "";
        req.on("data", (c: Buffer) => { body += c; });
        req.on("end", async () => {
          try {
            const { texts } = JSON.parse(body);
            if (!Array.isArray(texts) || texts.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "texts array required" }));
              return;
            }
            const embeddings = await deps.embedTexts!(texts);
            // Return as base64-encoded float32 arrays for efficiency
            const encoded = embeddings.map(e => Buffer.from(e.buffer).toString("base64"));
            res.end(JSON.stringify({ embeddings: encoded, dims: 384 }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message?.slice(0, 200) }));
          }
        });
        return;
      }

      // ── /health ──
      if (req.method === "GET" && url.pathname === "/health") {
        res.end(JSON.stringify({
          ok: true,
          epoch: serverEpoch,
          messages: feedBuffer.size,
          senseEvents: senseBuffer.size,
          overlayClients: wsHandler.clientCount,
          ...deps.getHealthPayload(),
        }));
        return;
      }

      // ── /cost ── live LLM cost + token summary with derived rates.
      if (req.method === "GET" && url.pathname === "/cost") {
        const s = deps.costTracker?.getSnapshot();
        if (!s) { res.end(JSON.stringify({ ok: false, error: "cost tracking unavailable" })); return; }
        const elapsedMin = Math.max(0.001, (Date.now() - s.startedAt) / 60_000);
        const round = (n: number, p = 6) => Math.round(n * 10 ** p) / 10 ** p;
        res.end(JSON.stringify({
          ok: true,
          totalCost: round(s.totalCost),
          callCount: s.callCount,
          elapsedMinutes: round(elapsedMin, 1),
          costBySource: s.costBySource,
          costByModel: s.costByModel,
          tokens: {
            totalIn: s.totalTokensIn,
            totalOut: s.totalTokensOut,
            inBySource: s.tokensInBySource,
            outBySource: s.tokensOutBySource,
          },
          rates: {
            costPerHour: round(s.totalCost / (elapsedMin / 60)),
            costPerCall: round(s.callCount ? s.totalCost / s.callCount : 0),
            avgTokensIn: s.callCount ? Math.round(s.totalTokensIn / s.callCount) : 0,
            avgTokensOut: s.callCount ? Math.round(s.totalTokensOut / s.callCount) : 0,
          },
        }));
        return;
      }

      // ── /setup/status ── (used by overlay onboarding wizard)
      if (req.method === "GET" && url.pathname === "/setup/status") {
        const health = deps.getHealthPayload();
        res.end(JSON.stringify({
          ok: true,
          setup: {
            openrouterKey: !!config.transcriptionConfig.openrouterApiKey,
            gatewayConfigured: !!config.openclawConfig.gatewayToken,
            gatewayConnected: !!(health as Record<string, any>)?.escalation?.gatewayConnected,
            audioActive: (health as Record<string, any>)?.audio?.state === "active" || (health as Record<string, any>)?.audioPipeline?.state === "running",
            screenActive: deps.isScreenActive(),
            transcriptionBackend: config.transcriptionConfig.backend,
            escalationMode: config.escalationConfig.mode,
          },
        }));
        return;
      }

      // ── /setup/providers ── (settings panel: active stack + local readiness)
      // The provider TOGGLE itself lives overlay-side (it rewrites
      // ~/.sinain/.env like the first-run wizard and relaunches); this
      // endpoint supplies everything the panel needs to render.
      if (req.method === "GET" && url.pathname === "/setup/providers") {
        const localMode = (process.env.SINAIN_LOCAL_MODE ?? "").toLowerCase() === "true";
        const analysisEndpoint = config.agentConfig.endpoint ?? "";
        const burstEndpoint = config.burstConfig.endpoint ?? "";
        const activeStack = localMode ? "local"
          : (analysisEndpoint.includes("cerebras") || burstEndpoint.includes("cerebras")) ? "cerebras"
          : "openrouter";
        const whisperReady = existsSync(config.transcriptionConfig.local.modelPath);
        // Ollama readiness: server reachable + the configured local models pulled.
        const localLlm = (process.env.SINAIN_LOCAL_LLM ?? "qwen2.5vl:7b").replace(/^ollama\//, "");
        const localVision = process.env.SINAIN_LOCAL_VISION ?? "qwen2.5vl:7b";
        let ollamaUp = false;
        let modelsPresent: string[] = [];
        try {
          const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
          ollamaUp = r.ok;
          const tags = await r.json() as { models?: { name: string }[] };
          modelsPresent = (tags.models ?? []).map(m => m.name);
        } catch { /* ollama down or absent */ }
        const modelReady = (want: string): boolean =>
          modelsPresent.some(n => n === want || n.startsWith(want.split(":")[0]));
        // Provisioning progress (written by tools/dmg/provision-*.sh).
        const provisioning: Record<string, string> = {};
        for (const f of ["ollama", "whisper"]) {
          try {
            provisioning[f] = readFileSync(join(homedir(), ".sinain", "provisioning", `${f}.status`), "utf8").trim();
          } catch { /* no status yet */ }
        }
        res.end(JSON.stringify({
          ok: true,
          activeStack,
          keys: {
            openrouter: !!process.env.OPENROUTER_API_KEY,
            cerebras: !!process.env.CEREBRAS_API_KEY || !!process.env.ANALYSIS_API_KEY,
          },
          local: {
            ollamaInstalled: ollamaUp || existsSync("/usr/local/bin/ollama") || existsSync("/opt/homebrew/bin/ollama")
              || existsSync("/Applications/Ollama.app"),
            ollamaUp,
            llm: localLlm, llmReady: modelReady(localLlm),
            vision: localVision, visionReady: modelReady(localVision),
            whisperReady,
          },
          provisioning,
        }));
        return;
      }

      // ── /setup/provision ── (settings panel: "Download local models" button)
      // Spawns the same background provisioning the DMG launcher runs on a
      // local-mode boot; progress lands in ~/.sinain/provisioning/*.status
      // and is surfaced by GET /setup/providers.
      if (req.method === "POST" && url.pathname === "/setup/provision") {
        const scriptDir = process.env.SINAIN_PROVISION_DIR
          || resolvePathJoin(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "dmg");
        const started: string[] = [];
        for (const script of ["provision-ollama.sh", "provision-whisper.sh"]) {
          const path = resolvePathJoin(scriptDir, script);
          if (!existsSync(path)) continue;
          const child = spawn("bash", [path], {
            detached: true, stdio: "ignore",
            env: { ...process.env },
          });
          child.unref();
          started.push(script);
        }
        if (!started.length) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: `no provisioning scripts at ${scriptDir}` }));
          return;
        }
        log("server", `provisioning started: ${started.join(", ")}`);
        res.end(JSON.stringify({ ok: true, started }));
        return;
      }

      // ── /user/command ──
      if (req.method === "POST" && url.pathname === "/user/command") {
        const body = await readBody(req, 4096);
        const { text } = JSON.parse(body);
        if (!text) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing text" }));
          return;
        }
        deps.setUserCommand?.(text);
        res.end(JSON.stringify({ ok: true, message: "Command queued for next escalation" }));
        return;
      }

      // ── /escalation/pending ──
      // Response piggybacks the per-lane agent config so run.sh learns
      // about overlay-side agent switches without a separate poll.
      if (req.method === "GET" && url.pathname === "/escalation/pending") {
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", terminalAgent: "", registered: false };
        const paused = deps.isEscalationPaused?.() ?? false;
        if (paused) {
          res.end(JSON.stringify({ ok: true, escalation: null, paused: true, config }));
          return;
        }
        const pending = deps.getEscalationPending?.();
        res.end(JSON.stringify({ ok: true, escalation: pending ?? null, config }));
        return;
      }

      // ── /escalation/respond ──
      if (req.method === "POST" && url.pathname === "/escalation/respond") {
        const body = await readBody(req, 65536);
        const { id, response } = JSON.parse(body);
        if (!id || !response) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing id or response" }));
          return;
        }
        const result = deps.respondEscalation?.(id, response) ?? { ok: false, error: "escalation not configured" };
        res.end(JSON.stringify(result));
        return;
      }

      // ── /spawn ── REMOVED (chat-threads redesign): no autonomous spawn
      // tasks. This was the sinain_spawn MCP tool's entry — agents were
      // spawning background work on their own and dumping results into the
      // feed. Agents answer inline; only the USER opens threads/terminals.
      if (req.method === "POST" && url.pathname === "/spawn") {
        res.writeHead(410);
        res.end(JSON.stringify({
          ok: false,
          error: "autonomous spawn tasks were removed — include your findings inline in the escalation response instead",
        }));
        return;
      }

      // ── /spawn/pending (bare agent polls for queued tasks) ──
      // Response piggybacks the per-lane agent config (see /escalation/pending).
      if (req.method === "GET" && url.pathname === "/spawn/pending") {
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", terminalAgent: "", registered: false };
        const task = deps.getSpawnPending?.() ?? null;
        res.end(JSON.stringify({ ok: true, task, config }));
        return;
      }

      // ── /roi/pending — desktop chat apps pull the ROI seed by id via the
      //    sinain_roi MCP tool. Core stashed it when routing the chat turn to a
      //    desktop agent (routeDesktopChat). No id → most recent seed. ──
      if (req.method === "GET" && url.pathname === "/roi/pending") {
        const s = roiSeeds.get(url.searchParams.get("id"));
        if (!s) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: "ROI seed not found or expired" }));
          return;
        }
        const enriched = url.searchParams.get("enriched") === "1";
        const text = enriched
          ? await composeServerBrief("", "", "full", {
              seedText: s.seed.text,
              threadId: s.regionId || undefined,
              knowledgeQuery: s.seed.text,
            })
          : s.seed.text;
        res.end(JSON.stringify({ ok: true, id: s.id, regionId: s.regionId, seed: { ...s.seed, text } }));
        return;
      }

      // ── /spawn/respond (bare agent returns task result) ──
      if (req.method === "POST" && url.pathname === "/spawn/respond") {
        const body = await readBody(req, 65536);
        const { id, result } = JSON.parse(body);
        if (!id || !result) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing id or result" }));
          return;
        }
        const resp = deps.respondSpawn?.(id, result) ?? { ok: false, error: "spawn not configured" };
        res.end(JSON.stringify(resp));
        return;
      }

      // ── /spawn/ask (MCP tool posts question, blocks until user replies) ──
      if (req.method === "POST" && url.pathname === "/spawn/ask") {
        const body = await readBody(req, 8192);
        const { taskId, question } = JSON.parse(body);
        if (!taskId || !question) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing taskId or question" }));
          return;
        }
        // Broadcast question to overlay
        deps.wsHandler?.broadcastRaw({
          type: "spawn_task",
          taskId,
          label: "user-command",
          status: "awaiting_input",
          startedAt: Date.now(),
          question,
        });
        // Hold response open until user replies (or timeout after 5 min)
        const answer = await new Promise<string>((resolve) => {
          const key = `ask:${taskId}`;
          pendingSpawnQuestions.set(key, resolve);
          setTimeout(() => {
            if (pendingSpawnQuestions.has(key)) {
              pendingSpawnQuestions.delete(key);
              resolve("(no reply — user did not respond within 5 minutes)");
            }
          }, 5 * 60_000);
        });
        res.end(JSON.stringify({ ok: true, answer }));
        return;
      }

      // ── /spawn/reply (overlay sends answer to a spawn question) ──
      if (req.method === "POST" && url.pathname === "/spawn/reply") {
        const body = await readBody(req, 8192);
        const { taskId, text } = JSON.parse(body);
        const key = `ask:${taskId}`;
        const resolve = pendingSpawnQuestions.get(key);
        if (resolve) {
          pendingSpawnQuestions.delete(key);
          resolve(text || "(empty reply)");
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.end(JSON.stringify({ ok: false, error: "no pending question for this task" }));
        }
        return;
      }

      // ── /spawn/approve (Claude hook posts tool permission, blocks until user decides) ──
      if (req.method === "POST" && url.pathname === "/spawn/approve") {
        const body = await readBody(req, 16384);
        const hookInput = JSON.parse(body);
        const tool = hookInput?.tool_name || hookInput?.toolName || "unknown";
        const input = hookInput?.tool_input || hookInput?.input || {};
        // session_id is provided by Claude Code / openclaude per the standard
        // PreToolUse hook contract — stable within one CLI invocation. Falls
        // back to sinainTaskId (injected by approve-tool.sh from env) for
        // hosts that don't emit session_id.
        const sessionId: string =
          (typeof hookInput?.session_id === "string" && hookInput.session_id) ||
          (typeof hookInput?.sinainTaskId === "string" && hookInput.sinainTaskId) ||
          "";

        // Auto-approve safe tools (configured via SINAIN_AUTO_APPROVE_TOOLS).
        // Tokens are exact matches, or prefix patterns ending with "*".
        const autoApproveTools = deps.config.permissionsConfig.autoApproveTools;
        const autoApproved = autoApproveTools.some((p) =>
          p.endsWith("*") ? tool.startsWith(p.slice(0, -1)) : tool === p,
        );
        if (autoApproved) {
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
          }));
          return;
        }

        // YOLO short-circuit: if the user previously clicked YOLO on any
        // permission prompt, auto-allow everything until core restarts. The
        // flag is process-global (not per-session) because claude -p creates
        // a fresh session_id per invocation and per-session YOLO never stuck.
        if (yoloActive) {
          res.end(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "YOLO mode active (process-global)",
            },
          }));
          return;
        }

        const taskId = `perm-${Date.now()}`;
        if (sessionId) permissionToSession.set(taskId, sessionId);
        // Broadcast permission request to overlay
        deps.wsHandler?.broadcastRaw({
          type: "spawn_task",
          taskId,
          label: "permission",
          status: "awaiting_permission",
          startedAt: Date.now(),
          permission: { tool, input },
        });
        // Hold response open until user decides
        const decision = await new Promise<string>((resolve) => {
          const key = `perm:${taskId}`;
          pendingSpawnQuestions.set(key, resolve);
          setTimeout(() => {
            if (pendingSpawnQuestions.has(key)) {
              pendingSpawnQuestions.delete(key);
              resolve("deny"); // default deny on timeout
            }
          }, 2 * 60_000);
        });
        // Clean up the permission→session mapping once we're done with it.
        permissionToSession.delete(taskId);
        const allowed = decision === "allow" || decision === "yolo";
        res.end(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: allowed ? "allow" : "deny",
            permissionDecisionReason:
              decision === "yolo" ? "User engaged YOLO mode — allow all for this session"
              : decision === "allow" ? "User approved via HUD"
              : "User denied or timed out",
          },
        }));
        return;
      }

      // ── /bareagent/register (bare agent announces its roster on startup) ──
      if (req.method === "POST" && url.pathname === "/bareagent/register") {
        const body = await readBody(req, 4096);
        let parsed: any;
        try { parsed = JSON.parse(body); }
        catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "invalid json" })); return; }
        const available = Array.isArray(parsed?.available) ? parsed.available : null;
        const current = typeof parsed?.current === "string" ? parsed.current : "";
        if (!available) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing available[]" }));
          return;
        }
        deps.registerBareAgent?.(available, current);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /bareagent/config (debug; the hot path uses the config field
      // piggybacked on /escalation/pending and /spawn/pending responses) ──
      if (req.method === "GET" && url.pathname === "/bareagent/config") {
        const cfg = deps.getBareAgentConfig?.() ?? { escalationAgent: "", terminalAgent: "", registered: false };
        res.end(JSON.stringify({ ok: true, ...cfg }));
        return;
      }

      // ── /spawn/permission-reply (overlay sends allow | deny | yolo) ──
      if (req.method === "POST" && url.pathname === "/spawn/permission-reply") {
        const body = await readBody(req, 1024);
        const { taskId, decision } = JSON.parse(body);
        const key = `perm:${taskId}`;
        const resolve = pendingSpawnQuestions.get(key);
        if (resolve) {
          pendingSpawnQuestions.delete(key);
          // YOLO: flip the process-global flag so every subsequent permission
          // request auto-allows until sinain-core restarts. Logs the triggering
          // session id (if known) for debug visibility.
          if (decision === "yolo") {
            yoloActive = true;
            const sid = permissionToSession.get(taskId);
            log(TAG, `YOLO mode activated (triggered by sessionId=${sid || "<none>"})`);
          }
          resolve(decision || "deny");
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.end(JSON.stringify({ ok: false, error: "no pending permission for this task" }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err: any) {
      const status = err.message === "body too large" ? 413 : 400;
      res.writeHead(status);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // Attach WS server on the same HTTP server
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws, req) => {
    const pathname = new URL(req.url || "/", `http://localhost:${config.port}`).pathname;

    // Sense WebSocket endpoint for low-latency event streaming
    if (pathname === "/sense/ws") {
      log(TAG, "[sense/ws] client connected");

      // Backpressure tracking
      let pendingAcks = 0;
      const MAX_PENDING = 5;

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Gate sense ingestion when screen is toggled off
          if (!deps.isScreenActive()) {
            ws.send(JSON.stringify({ type: "ack", gated: true }));
            return;
          }

          // Handle different message types
          if (msg.type === "delta") {
            // Delta-only update (new semantic format)
            senseBuffer.pushDelta({
              app: msg.app || "unknown",
              activity: msg.activity || "unknown",
              changes: msg.changes || [],
              priority: msg.priority,
              ts: msg.ts || Date.now(),
            });

            // Trigger immediate context update for urgent priority
            if (msg.priority === "urgent") {
              deps.onSenseDelta?.(msg);
            }

            // Send ack with backpressure signal
            pendingAcks++;
            const backpressure = pendingAcks > MAX_PENDING ? 100 : 0;
            ws.send(JSON.stringify({ type: "ack", backpressure }));
            pendingAcks = Math.max(0, pendingAcks - 1);

          } else {
            // Full event (backwards compatible)
            const imageData = msg.roi?.data || undefined;
            const imageBbox = msg.roi?.bbox || undefined;
            const frameSize = Array.isArray(msg.roi?.frame_size) ? msg.roi.frame_size : undefined;
            const ocrLines = Array.isArray(msg.ocr_lines) ? msg.ocr_lines.slice(0, 40) : undefined;

            const event = senseBuffer.push({
              type: msg.type,
              ts: msg.ts,
              ocr: msg.ocr || "",
              imageData,
              imageBbox,
              frameSize,
              ocrLines,
              meta: {
                ssim: msg.meta?.ssim ?? 0,
                app: msg.meta?.app || "unknown",
                windowTitle: msg.meta?.windowTitle,
                screen: msg.meta?.screen ?? 0,
              },
              semantic: msg.semantic,
              priority: msg.priority,
            });

            if (event) {
              deps.onSenseEvent(event);

              // Send ack with event ID
              pendingAcks++;
              const backpressure = pendingAcks > MAX_PENDING ? 100 : 0;
              ws.send(JSON.stringify({ type: "ack", id: event.id, backpressure }));
              pendingAcks = Math.max(0, pendingAcks - 1);
            } else {
              // Deduplicated
              ws.send(JSON.stringify({ type: "ack", deduplicated: true }));
            }
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      });

      ws.on("close", () => {
        log(TAG, "[sense/ws] client disconnected");
      });

      ws.on("error", (err) => {
        error(TAG, `[sense/ws] error: ${err.message}`);
      });

      return;
    }

    // Default: overlay WebSocket handler
    wsHandler.handleConnection(ws, req);
  });

  return {
    httpServer,
    wss,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        // SECURITY: bind loopback-only by default (config.host = 127.0.0.1).
        // The HTTP/WS API has no authentication, so LAN exposure (0.0.0.0)
        // must be a deliberate opt-in via SINAIN_BIND_HOST.
        httpServer.listen(config.port, config.host, () => {
          log(TAG, `listening on http://${config.host}:${config.port} (HTTP + WS, epoch=${serverEpoch})`);
          if (config.host === "0.0.0.0") {
            log(TAG, "WARNING: bound on 0.0.0.0 — API is reachable from the LAN with no auth (SINAIN_BIND_HOST override)");
          }
          resolve();
        });
      });
    },
    async destroy(): Promise<void> {
      clearInterval(visionCostCleanup);
      wsHandler.destroy();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      log(TAG, "server closed");
    },
  };
}
