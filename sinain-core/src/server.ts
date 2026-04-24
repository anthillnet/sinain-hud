import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { CoreConfig, SenseEvent } from "./types.js";
import type { Profiler } from "./profiler.js";
import type { CostTracker } from "./cost/tracker.js";
import type { FeedbackStore } from "./learning/feedback-store.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer, type SemanticSenseEvent, type TextDelta } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
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
    const res = await fetch('/knowledge/entities?max=200');
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
  profiler?: Profiler;
  costTracker?: CostTracker;
  onSenseEvent: (event: SenseEvent) => void;
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
  getKnowledgeDocPath?: () => string | null;
  queryKnowledgeFacts?: (entities: string[], maxFacts: number) => Promise<string>;
  listKnowledgeEntities?: (max: number) => Promise<string>;
  exportKnowledge?: (domain: string | null, max: number) => Promise<string>;
  importKnowledge?: (data: string) => Promise<string>;
  onSpawnCommand?: (text: string) => void;
  getSpawnPending?: () => { id: string; task: string; label: string; ts: number } | null;
  respondSpawn?: (id: string, result: string) => { ok: boolean; error?: string };
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>;
  isEmbeddingReady?: () => boolean;

  /** Bare-agent announced its roster on startup. */
  registerBareAgent?: (available: string[], current: string) => void;
  /** Current per-lane agent choice; read by run.sh via the piggyback field
   *  on /escalation/pending and /spawn/pending responses, and by manual
   *  debug via GET /bareagent/config. */
  getBareAgentConfig?: () => { escalationAgent: string; spawnAgent: string };
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

// YOLO mode: "allow all" for the current agent session. Keyed on the openclaude
// session_id from the PreToolUse hook input (stable across tool calls within
// one invoke_agent run, discarded when that run ends). User enters YOLO by
// clicking the YOLO button on any permission prompt. Session id is cleared
// implicitly when the bare agent restarts (new session_id on next run).
const yoloSessions = new Set<string>();
// Map permission-request id (perm-<ts>) -> session id it came from. Used so
// that /spawn/permission-reply can flag the right session as YOLO when the
// user picks the YOLO button. Cleaned on resolve/timeout.
const permissionToSession = new Map<string, string>();

export function createAppServer(deps: ServerDeps) {
  const { config, feedBuffer, senseBuffer, wsHandler } = deps;
  let senseInBytes = 0;
  const seenVisionCostIds = new Set<string>();
  const visionCostCleanup = setInterval(() => seenVisionCostIds.clear(), 60_000);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${config.port}`);

    try {
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

        const event = senseBuffer.push({
          type: data.type,
          ts: data.ts,
          ocr: data.ocr || "",
          imageData,
          imageBbox,
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

      // ── /agent ──
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
        const max = Math.min(parseInt(url.searchParams.get("max") || "50"), 200);
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

      if (req.method === "GET" && url.pathname === "/knowledge/ui") {
        // Simple web UI for browsing and transferring knowledge
        res.setHeader("Content-Type", "text/html");
        res.end(KNOWLEDGE_UI_HTML);
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
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "" };
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

      // ── /spawn ──
      if (req.method === "POST" && url.pathname === "/spawn") {
        const body = await readBody(req, 65536);
        const { text, label } = JSON.parse(body);
        if (!text) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing text" }));
          return;
        }
        if (deps.onSpawnCommand) {
          deps.onSpawnCommand(text);
          res.end(JSON.stringify({ ok: true, spawned: true }));
        } else {
          res.end(JSON.stringify({ ok: false, error: "spawn not configured" }));
        }
        return;
      }

      // ── /spawn/pending (bare agent polls for queued tasks) ──
      // Response piggybacks the per-lane agent config (see /escalation/pending).
      if (req.method === "GET" && url.pathname === "/spawn/pending") {
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "" };
        const task = deps.getSpawnPending?.() ?? null;
        res.end(JSON.stringify({ ok: true, task, config }));
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

        // YOLO short-circuit: if this session previously clicked YOLO, auto-allow
        // without routing to overlay. No user interaction needed.
        if (sessionId && yoloSessions.has(sessionId)) {
          res.end(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "YOLO mode active for this session",
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
        const cfg = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "" };
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
          // YOLO: flag the session so subsequent permission requests for the
          // same openclaude invocation auto-allow without routing to overlay.
          // Session id was captured in permissionToSession when we broadcast
          // the request; it's cleared by the /spawn/approve handler after resolve.
          if (decision === "yolo") {
            const sid = permissionToSession.get(taskId);
            if (sid) yoloSessions.add(sid);
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

            const event = senseBuffer.push({
              type: msg.type,
              ts: msg.ts,
              ocr: msg.ocr || "",
              imageData,
              imageBbox,
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
        httpServer.listen(config.port, "0.0.0.0", () => {
          log(TAG, `listening on http://0.0.0.0:${config.port} (HTTP + WS, epoch=${serverEpoch})`);
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
