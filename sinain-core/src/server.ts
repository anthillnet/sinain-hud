import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { CoreConfig, SenseEvent } from "./types.js";
import type { Profiler } from "./profiler.js";
import type { CostTracker } from "./cost/tracker.js";
import type { FeedbackStore } from "./learning/feedback-store.js";
import type { WebDb, BookmarkStatus } from "./web-db/store.js";
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

// ──────────────────────────────────────────────────────────────────────────
// Knowledge UI V2 — "Living Confluence" SPA. Replaces the legacy fact-browser
// (still served at /knowledge/ui-legacy). Single inline file to preserve
// the zero-build single-file deploy story.
// ──────────────────────────────────────────────────────────────────────────
const KNOWLEDGE_UI_V2_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sinain Knowledge</title>
<style>
  :root {
    /* Day theme: neutral white/black/blue. Surfaces use light slate
       grays for layered elevation (no tint), text is near-black, accent
       is a single blue used for entity links, primary buttons, and the
       summary border. Avoids any saturated greens/reds outside semantic
       warn/danger usage. */
    --bg: #ffffff; --bg-elev: #f8fafc; --bg-hover: #f1f5f9;
    --fg: #0f172a; --fg-dim: #475569; --fg-faint: #94a3b8;
    --accent: #2563eb; --accent-dim: #1d4ed8;
    --warn: #b45309; --danger: #b91c1c;
    --border: #e2e8f0; --border-strong: #cbd5e1;
    --chip: #f1f5f9;
    --shadow: 0 4px 18px rgba(15, 23, 42, 0.08);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         font-size: 14px; line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { background: var(--bg-elev); color: var(--fg); border: 1px solid var(--border);
           padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  button:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  button.primary { background: var(--accent); color: #ffffff; border-color: var(--accent); font-weight: 600; }
  button.primary:hover { background: var(--accent-dim); border-color: var(--accent-dim); }
  button.danger { color: var(--danger); }
  /* Destructive-primary (e.g. modal "Retract"): solid red, not the awkward
     blue-bg + red-text combination of stacking the two classes. */
  button.primary.danger { background: var(--danger); border-color: var(--danger); color: #ffffff; }
  button.primary.danger:hover { background: #991b1b; border-color: #991b1b; color: #ffffff; }
  button.icon { padding: 4px 8px; }
  input, textarea, select { background: var(--bg-elev); color: var(--fg);
            border: 1px solid var(--border); padding: 8px 12px; border-radius: 6px;
            font: inherit; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  /* Header */
  header { position: sticky; top: 0; z-index: 100; background: var(--bg);
           border-bottom: 1px solid var(--border); padding: 12px 24px;
           display: flex; gap: 16px; align-items: center; }
  .logo { font-weight: 700; color: var(--accent); font-size: 16px;
          cursor: pointer; flex-shrink: 0; }
  .search-wrap { position: relative; flex: 1; max-width: 600px; }
  #search { width: 100%; padding: 10px 14px; font-size: 15px; }
  .search-results { position: absolute; top: 100%; left: 0; right: 0;
            background: var(--bg-elev); border: 1px solid var(--border);
            border-radius: 6px; margin-top: 4px; max-height: 400px; overflow-y: auto;
            box-shadow: var(--shadow); display: none; }
  .search-results.open { display: block; }
  .search-result { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--border); }
  .search-result:hover { background: var(--bg-hover); }
  .search-result:last-child { border-bottom: none; }
  .search-result .entity { color: var(--accent); font-weight: 600; font-size: 13px; }
  .search-result .meta { color: var(--fg-dim); font-size: 11px; margin-top: 2px; }
  .search-result .snippet { color: var(--fg); font-size: 13px; margin-top: 4px; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; }
  /* Main */
  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  h1 { color: var(--fg); font-size: 20px; margin: 0 0 16px; }
  h2 { color: var(--fg); font-size: 16px; margin: 24px 0 12px; }
  h3 { color: var(--fg); font-size: 14px; margin: 16px 0 8px; font-weight: 600; }
  /* Home */
  .bookmark-row { margin-bottom: 24px; }
  .bookmark-row h2 { color: var(--accent); margin-bottom: 8px; }
  .bookmark-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                   gap: 10px; }
  .bookmark-card { background: var(--bg-elev); border: 1px solid var(--border);
                   border-radius: 6px; padding: 12px; cursor: pointer;
                   transition: border-color 0.15s; }
  .bookmark-card:hover { border-color: var(--accent-dim); }
  .bookmark-card .entity { font-weight: 600; color: var(--accent); font-size: 13px;
                           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bookmark-card .meta { color: var(--fg-dim); font-size: 11px; margin-top: 4px; }
  .empty-row { color: var(--fg-faint); font-style: italic; padding: 8px; }
  /* Import dropzone */
  .dropzone { border: 2px dashed var(--border-strong); border-radius: 8px;
              padding: 32px; text-align: center; color: var(--fg-dim); cursor: pointer;
              margin-top: 24px; transition: border-color 0.15s; }
  .dropzone:hover, .dropzone.drag-over { border-color: var(--accent); color: var(--fg); }
  /* Entity page */
  .page-header { padding-bottom: 16px; border-bottom: 1px solid var(--border);
                 margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 12px;
                 align-items: center; }
  .page-header .title { font-size: 22px; font-weight: 700; flex: 1; }
  .page-header .badges { color: var(--fg-dim); font-size: 12px; }
  .page-header .badge { background: var(--chip); padding: 3px 8px; border-radius: 4px;
                        margin-right: 6px; }
  .page-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .layout-3col { display: grid; grid-template-columns: 220px 1fr 240px; gap: 24px; }
  @media (max-width: 1100px) { .layout-3col { grid-template-columns: 1fr; } }
  /* Tree */
  .tree { font-size: 12px; }
  .tree-group { margin-bottom: 12px; }
  .tree-group-label { color: var(--accent); font-weight: 600; font-size: 11px;
                      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .tree-node { padding: 4px 6px; border-radius: 4px; cursor: pointer;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree-node:hover { background: var(--bg-hover); }
  .tree-node.expandable::before { content: "▸ "; color: var(--fg-dim); }
  .tree-node.expanded::before { content: "▾ "; color: var(--accent); }
  .tree-children { padding-left: 12px; border-left: 1px solid var(--border); margin-left: 6px; }
  /* Page body */
  .summary { background: var(--bg-elev); border-left: 3px solid var(--accent);
             padding: 16px; border-radius: 0 6px 6px 0; margin-bottom: 24px;
             font-size: 15px; }
  .section { margin-bottom: 24px; }
  .section-heading { color: var(--fg); font-size: 17px; font-weight: 600;
                     border-bottom: 1px solid var(--border); padding-bottom: 6px;
                     margin-bottom: 12px; cursor: pointer; user-select: none; }
  .section-heading::before { content: "▾ "; color: var(--fg-dim); }
  .section.collapsed .section-heading::before { content: "▸ "; }
  .section.collapsed .bullets { display: none; }
  .bullets { list-style: none; padding: 0; margin: 0; }
  .bullet { padding: 8px 12px; border-radius: 6px; margin-bottom: 4px;
            display: flex; gap: 12px; align-items: flex-start;
            transition: background 0.15s; position: relative; }
  .bullet:hover { background: var(--bg-elev); }
  .bullet.retracting { opacity: 0.4; text-decoration: line-through;
                       transition: opacity 0.3s, transform 0.3s; }
  .bullet .text { flex: 1; }
  .bullet .conf { color: var(--fg-faint); font-size: 11px; flex-shrink: 0;
                  font-variant-numeric: tabular-nums; }
  .bullet .fid { color: var(--fg-faint); font-size: 10px; font-family: ui-monospace, monospace;
                 cursor: pointer; }
  .bullet .fid:hover { color: var(--accent); }
  .bullet .more { color: var(--fg-faint); cursor: pointer; padding: 0 4px;
                  visibility: hidden; }
  .bullet:hover .more { visibility: visible; }
  .bullet .more:hover { color: var(--accent); }
  .section .notes { color: var(--warn); font-size: 12px; font-style: italic;
                    padding: 4px 12px; }
  /* Raw facts accordion */
  .raw-accordion { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 16px; }
  .raw-toggle { color: var(--accent); cursor: pointer; user-select: none; font-size: 13px; }
  .raw-list { display: none; margin-top: 12px; }
  .raw-list.open { display: block; }
  .raw-item { padding: 6px 12px; font-family: ui-monospace, monospace; font-size: 11px;
              color: var(--fg-dim); border-left: 2px solid var(--border); margin-bottom: 4px; }
  /* Meta panel */
  .meta-panel { font-size: 12px; color: var(--fg-dim); }
  .meta-panel .stat-row { display: flex; justify-content: space-between;
                          padding: 4px 0; border-bottom: 1px solid var(--border); }
  .meta-panel .stat-row:last-child { border-bottom: none; }
  .meta-panel .stat-label { color: var(--fg-faint); }
  .meta-panel .stat-value { color: var(--fg); font-variant-numeric: tabular-nums; }
  /* Modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6);
                    display: none; align-items: center; justify-content: center;
                    z-index: 1000; }
  .modal-backdrop.open { display: flex; }
  .modal { background: var(--bg-elev); border-radius: 8px; padding: 24px;
           max-width: 480px; width: 90%; box-shadow: var(--shadow); }
  .modal h2 { margin-top: 0; }
  .modal .body { color: var(--fg); margin-bottom: 16px; }
  .modal .quote { color: var(--fg); padding: 8px 12px; background: var(--bg);
                  border-left: 3px solid var(--warn); border-radius: 0 4px 4px 0;
                  margin: 8px 0; }
  .modal label { display: block; margin: 12px 0 4px; color: var(--fg-dim); font-size: 12px; }
  .modal textarea { width: 100%; min-height: 60px; resize: vertical; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  /* Toast */
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--bg-elev);
           border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px;
           box-shadow: var(--shadow); display: flex; gap: 12px; align-items: center;
           min-width: 320px; max-width: 480px; z-index: 1000; animation: slidein 0.2s; }
  @keyframes slidein { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .toast .icon { color: var(--accent); }
  .toast .text { flex: 1; font-size: 13px; }
  .toast .timer { height: 2px; background: var(--accent); position: absolute;
                  bottom: 0; left: 0; transition: width linear; }
  .toast button { padding: 4px 10px; font-size: 12px; }
  /* Share badge in header */
  .share-badge { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
  /* Shares view */
  .shares-list { display: flex; flex-direction: column; gap: 12px; }
  .share-row { background: var(--bg-elev); border: 1px solid var(--border);
               border-radius: 6px; padding: 14px 16px;
               display: grid; grid-template-columns: auto 1fr auto; gap: 12px;
               align-items: center; }
  .share-row .icon { font-size: 18px; line-height: 1; }
  .share-row .body { min-width: 0; }
  .share-row .title { font-weight: 600; color: var(--accent); white-space: nowrap;
                      overflow: hidden; text-overflow: ellipsis; }
  .share-row .meta { color: var(--fg-dim); font-size: 12px; margin-top: 2px;
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .share-row .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .share-row .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
                     letter-spacing: 0.02em; text-transform: uppercase; }
  .pill-waiting    { background: rgba(180,83,9,0.10);   color: var(--warn); }
  .pill-connecting { background: rgba(37,99,235,0.10);  color: var(--accent); }
  .pill-delivered  { background: rgba(21,128,61,0.10);  color: #15803d; }
  .pill-disconnected { background: var(--chip);          color: var(--fg-faint); }
  .pill-revoked    { background: rgba(185,28,28,0.08);  color: var(--danger); }
  .pill-expired    { background: var(--chip);            color: var(--fg-faint); }
  .pill-permanent  { background: var(--chip);            color: var(--fg-dim); }
  .pulse { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  /* Loading */
  .spinner { display: inline-block; width: 14px; height: 14px;
             border: 2px solid var(--border); border-top-color: var(--accent);
             border-radius: 50%; animation: spin 0.8s linear infinite;
             vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-block { padding: 32px; text-align: center; color: var(--fg-dim); }
  .error-block { padding: 24px; background: rgba(185, 28, 28, 0.05);
                 border-left: 3px solid var(--danger); border-radius: 0 6px 6px 0;
                 color: var(--fg); }
</style>
</head>
<body>
<header>
  <div class="logo" onclick="navigate('/knowledge/ui')">SINAIN</div>
  <div class="search-wrap">
    <input id="search" type="text" placeholder="Search entities, topics, people…" autocomplete="off" />
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="header-actions">
    <button onclick="navigate('/knowledge/ui/shares')" title="My share links">📤 Shares <span id="shareBadge" class="share-badge"></span></button>
    <a href="/knowledge/ui-legacy"><button>Legacy view</button></a>
  </div>
</header>
<main id="root"></main>
<div id="modalRoot"></div>
<div id="toastRoot"></div>

<script>
// ── Util ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = (sel) => document.querySelector(sel);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── API ───────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, opts);
    if (!res.ok && res.status !== 404) {
      // Some endpoints (e.g. retract on missing fact) return error JSON with non-200.
      // We still try to parse — ok=false in body is the contract.
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("json")) return await res.json();
    return await res.text();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Cross-machine sharing config (env-injected at serve time) ────────────
const SHARE_PEERJS_HOST = __SHARE_PEERJS_HOST__;     // empty string → peerjs.com cloud
const SHARE_INLINE_MAX_BYTES = __SHARE_INLINE_MAX_BYTES__;
const SHARE_TTL_HOURS = __SHARE_TTL_HOURS__;
const SHARE_BASE_URL = __SHARE_BASE_URL__;            // public redirector that points to localhost

// ── Router ────────────────────────────────────────────────────────────────
function navigate(path) {
  history.pushState({}, "", path);
  render();
}
window.addEventListener("popstate", render);
window.addEventListener("DOMContentLoaded", () => {
  setupSearch();
  setupGlobalDrop();
  ShareManager.resumePeerShares().catch(e => console.warn("share resume failed", e));
  refreshShareBadge();
  render();
});

function render() {
  const path = location.pathname;
  if (path === "/knowledge/ui" || path === "/knowledge/ui/") {
    renderHome();
  } else if (path === "/knowledge/ui/shares" || path === "/knowledge/ui/shares/") {
    renderSharesView();
  } else if (path.startsWith("/knowledge/ui/entity/")) {
    const entity = decodeURIComponent(path.slice("/knowledge/ui/entity/".length));
    renderEntityPage(entity);
  } else if (path.startsWith("/knowledge/ui/topic/")) {
    const q = decodeURIComponent(path.slice("/knowledge/ui/topic/".length));
    renderTopicPage(q);
  } else {
    renderHome();
  }
}

// ── Share infrastructure (gzip helpers, peerjs loader, ShareManager) ─────

function randomHex(byteCount) {
  const buf = new Uint8Array(byteCount);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

async function gzipBase64(text) {
  // CompressionStream("gzip") is in all modern browsers (Chrome 80+, Safari
  // 16.4+, Firefox 113+). No external library needed.
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  // base64url so the output is URL-safe (no +, /, =).
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}

async function ungzipBase64(encoded) {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((encoded.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(ds).text();
}

let _peerjsLoading = null;
function ensurePeerJsLoaded() {
  if (window.Peer) return Promise.resolve();
  if (_peerjsLoading) return _peerjsLoading;
  _peerjsLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    // Pinned version + SRI hash. If you bump version, regenerate hash via:
    //   curl -sL https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js | openssl dgst -sha384 -binary | openssl base64 -A
    s.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
    s.crossOrigin = "anonymous";
    s.onload = () => res();
    s.onerror = (e) => rej(new Error("peerjs failed to load — network or CDN issue"));
    document.head.appendChild(s);
  });
  return _peerjsLoading;
}

function newPeer(idOrUndef) {
  // Honor SHARE_PEERJS_HOST env-injected override. Empty string = peerjs.com default.
  // debug: 3 enables verbose peerjs logging in console — critical for diagnosing
  // WebRTC handshake failures (NAT, ICE state transitions, peer-unavailable, etc.).
  const opts = SHARE_PEERJS_HOST ? { host: SHARE_PEERJS_HOST, debug: 3 } : { debug: 3 };
  return idOrUndef ? new window.Peer(idOrUndef, opts) : new window.Peer(opts);
}

// Attach detailed instrumentation to a peer + its underlying RTCPeerConnections.
// Logs to console (sinain-share namespace) so diagnostics are visible without
// any UI changes. Tracks the four state machines that matter for WebRTC: ICE
// gathering, ICE connection, peerconnection, and signaling.
function instrumentPeer(peer, label) {
  const tag = "[sinain-share:" + label + "]";
  console.log(tag, "instrumented peer", peer.id || "(no-id-yet)");
  peer.on("open", id => console.log(tag, "peer.open id=" + id));
  peer.on("error", e => console.warn(tag, "peer.error type=" + (e && e.type) + " msg=" + (e && e.message)));
  peer.on("disconnected", () => console.warn(tag, "peer.disconnected (lost broker connection)"));
  peer.on("close", () => console.log(tag, "peer.close (destroyed)"));
}

function instrumentConnection(conn, label) {
  const tag = "[sinain-share:" + label + ":" + (conn.peer || "?") + "]";
  console.log(tag, "new connection, reliable=" + conn.reliable);
  conn.on("open", () => console.log(tag, "conn.open (DataChannel ready)"));
  conn.on("error", e => console.warn(tag, "conn.error", e));
  conn.on("close", () => console.log(tag, "conn.close"));
  conn.on("iceStateChanged", s => console.log(tag, "conn.iceStateChanged →", s));
  // Tap into the underlying RTCPeerConnection. peerjs exposes it as
  // conn.peerConnection (it might not exist immediately — wait a tick).
  setTimeout(() => {
    const pc = conn.peerConnection;
    if (!pc) { console.warn(tag, "no peerConnection exposed"); return; }
    pc.addEventListener("iceconnectionstatechange",
      () => console.log(tag, "iceConnectionState →", pc.iceConnectionState));
    pc.addEventListener("connectionstatechange",
      () => console.log(tag, "connectionState →", pc.connectionState));
    pc.addEventListener("icegatheringstatechange",
      () => console.log(tag, "iceGatheringState →", pc.iceGatheringState));
    pc.addEventListener("signalingstatechange",
      () => console.log(tag, "signalingState →", pc.signalingState));
    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) { console.log(tag, "ICE gathering complete"); return; }
      const c = e.candidate;
      // Log candidate type (host = local LAN, srflx = STUN, relay = TURN, prflx = peer-reflexive).
      // If we never see "relay" but only "host"/"srflx" and connection fails, NAT traversal
      // requires TURN — which peerjs cloud doesn't provide.
      const type = (c.candidate.match(/typ (\\S+)/) || [])[1] || "?";
      console.log(tag, "iceCandidate type=" + type + " proto=" + c.protocol + " addr=" + (c.address || "?") + ":" + (c.port || "?"));
    });
  }, 100);
}

const ShareManager = (() => {
  // share_token → live Peer instance (sender side only). Bundles are re-fetched
  // on demand rather than kept in JS memory across resume.
  const peers = new Map();

  async function buildBundle(entity) {
    const r = await fetch(\`/knowledge/concepts/export?entity=\${encodeURIComponent(entity)}\` +
      \`&depth=1&include_page=1\`);
    if (!r.ok) throw new Error("export failed: " + r.status);
    return await r.text();
  }

  // Build the public-shareable URL. Recipient pastes this anywhere; the
  // redirector at SHARE_BASE_URL does a client-side rewrite to their local
  // sinain-core (location.href = "http://localhost:<port>/...#hash") with
  // the fragment preserved (browsers don't send fragments to the server,
  // so bundle bytes never touch the CDN).
  function buildShareUrl(entity, hash) {
    const port = location.port || (location.protocol === "https:" ? "443" : "80");
    const params = new URLSearchParams({ entity, port });
    return SHARE_BASE_URL + "?" + params.toString() + hash;
  }

  async function createShare(entity) {
    const bundle = await buildBundle(entity);
    const sizeBytes = new TextEncoder().encode(bundle).length;
    const token = randomHex(8);  // 16 hex chars

    if (sizeBytes <= SHARE_INLINE_MAX_BYTES) {
      const compressed = await gzipBase64(bundle);
      const url = buildShareUrl(entity, "#bundle=" + compressed);
      await api("/knowledge/shares", { method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          entity_id: entity, mode: "fragment", share_token: token, url, bundle_size: sizeBytes
        })
      });
      try { await navigator.clipboard.writeText(url); } catch { /* clipboard denied */ }
      showToast("✓ Link copied · self-contained, can't be revoked", 6000);
      refreshShareBadge();
      return { mode: "fragment", url };
    }

    // Peer mode
    await ensurePeerJsLoaded();
    const peer = newPeer(token);
    instrumentPeer(peer, "sender:" + token.slice(0, 8));
    await new Promise((res, rej) => {
      peer.on("open", () => res());
      peer.on("error", e => rej(e));
      setTimeout(() => rej(new Error("peerjs broker timeout")), 8000);
    });
    const url = buildShareUrl(entity, "#peer=" + token);
    await api("/knowledge/shares", { method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        entity_id: entity, mode: "peer", share_token: token, url, bundle_size: sizeBytes
      })
    });
    peers.set(token, peer);
    attachSenderHandlers(peer, token, entity);
    try { await navigator.clipboard.writeText(url); } catch {}
    showToast("✓ Link copied · live until you revoke (see Shares)", 6000);
    refreshShareBadge();
    return { mode: "peer", url };
  }

  function attachSenderHandlers(peer, token, entity) {
    peer.on("connection", (conn) => {
      console.log("[sinain-share:sender:" + token.slice(0, 8) + "] inbound connection from", conn.peer);
      instrumentConnection(conn, "sender");
      patchStatus(token, "connecting");
      conn.on("open", async () => {
        try {
          // Re-fetch bundle each time — keeps memory low and reflects latest state.
          const bundle = await buildBundle(entity);
          console.log("[sinain-share:sender:" + token.slice(0, 8) + "] sending bundle, " + bundle.length + " bytes");
          conn.send({ type: "bundle", payload: bundle });
        } catch (e) {
          console.warn("[sinain-share:sender] buildBundle/send failed:", e);
          conn.send({ type: "error", message: String(e).slice(0, 200) });
          conn.close();
        }
      });
      conn.on("data", (msg) => {
        if (msg && msg.type === "ack") {
          patchStatus(token, "delivered", { delivered_at: Date.now() });
          // Keep peer alive briefly for retries, then release.
          setTimeout(() => destroyPeer(token), 5000);
        }
      });
      conn.on("close", () => { /* normal */ });
    });
    peer.on("disconnected", () => patchStatus(token, "disconnected"));
    peer.on("close", () => patchStatus(token, "disconnected"));
    peer.on("error", (err) => {
      console.warn("share peer error", token, err && err.type, err && err.message);
    });
  }

  async function patchStatus(token, status, extra) {
    const body = Object.assign({ status }, extra || {});
    await api("/knowledge/shares/" + encodeURIComponent(token), {
      method: "PATCH", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    refreshShareBadge();
  }

  async function resumePeerShares() {
    const r = await api("/knowledge/shares?status=waiting&status=connecting&status=disconnected");
    if (!r || !r.ok) return;
    for (const share of r.shares || []) {
      if (share.mode !== "peer") continue;
      try {
        await ensurePeerJsLoaded();
        const peer = newPeer(share.share_token);
        instrumentPeer(peer, "sender-resume:" + share.share_token.slice(0, 8));
        await new Promise((res, rej) => {
          peer.on("open", () => res());
          peer.on("error", e => rej(e));
          setTimeout(() => rej(new Error("peerjs open timeout")), 8000);
        });
        peers.set(share.share_token, peer);
        attachSenderHandlers(peer, share.share_token, share.entity_id);
        if (share.status !== "waiting") {
          await patchStatus(share.share_token, "waiting");
        }
      } catch (e) {
        console.warn("resume failed for", share.share_token, e && e.message);
        // Mark as disconnected so the user sees it failed; they can manually revoke.
        await patchStatus(share.share_token, "disconnected").catch(() => {});
      }
    }
  }

  function destroyPeer(token) {
    const peer = peers.get(token);
    if (peer) {
      try { peer.destroy(); } catch {}
      peers.delete(token);
    }
  }

  async function revoke(token) {
    destroyPeer(token);
    await api("/knowledge/shares/" + encodeURIComponent(token), {
      method: "PATCH", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ status: "revoked", revoked_at: Date.now() })
    });
    refreshShareBadge();
  }

  async function forget(token) {
    destroyPeer(token);
    await api("/knowledge/shares/" + encodeURIComponent(token), { method: "DELETE" });
    refreshShareBadge();
  }

  async function connectAsRecipient(token) {
    showToast('<span class="spinner"></span> Connecting peer-to-peer…', 30_000);
    console.log("[sinain-share:recipient:" + token.slice(0, 8) + "] connectAsRecipient start");
    await ensurePeerJsLoaded();
    const me = newPeer();
    instrumentPeer(me, "recipient:" + token.slice(0, 8));
    await new Promise((res, rej) => {
      me.on("open", () => res());
      me.on("error", e => rej(e));
      setTimeout(() => rej(new Error("peerjs broker timeout")), 8000);
    });
    console.log("[sinain-share:recipient:" + token.slice(0, 8) + "] my peer registered, dialing", token);
    return new Promise((resolve, reject) => {
      const conn = me.connect(token, { reliable: true });
      instrumentConnection(conn, "recipient");
      const cleanup = () => { try { conn.close(); } catch {} try { me.destroy(); } catch {} };
      const openTimeout = setTimeout(() => {
        console.warn("[sinain-share:recipient:" + token.slice(0, 8) + "] 15s timeout — conn.open never fired. Almost certainly NAT traversal failed (no TURN). Look for ICE candidate types above — only host/srflx without 'relay' = TURN missing.");
        cleanup();
        reject(new Error("source offline or unreachable"));
      }, 15_000);
      conn.on("open", () => {
        clearTimeout(openTimeout);
        console.log("[sinain-share:recipient:" + token.slice(0, 8) + "] DataChannel open — waiting for bundle");
      });
      conn.on("error", (e) => {
        console.warn("[sinain-share:recipient:" + token.slice(0, 8) + "] conn.error", e);
        cleanup(); reject(e);
      });
      conn.on("data", async (msg) => {
        if (!msg) return;
        if (msg.type === "error") {
          console.warn("[sinain-share:recipient] source reported error:", msg.message);
          cleanup();
          reject(new Error("source error: " + msg.message));
          return;
        }
        if (msg.type === "bundle") {
          console.log("[sinain-share:recipient:" + token.slice(0, 8) + "] bundle received, " + (msg.payload && msg.payload.length) + " bytes — POSTing to /knowledge/concepts/import");
          try {
            const importR = await api("/knowledge/concepts/import?conflict=merge", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: msg.payload,
            });
            console.log("[sinain-share:recipient] import response:", importR);
            // CRITICAL: api() doesn't throw on {ok:false} responses — it
            // returns the parsed body. We MUST check ok explicitly here, or
            // a backend failure (script ENOENT, schema error, etc.) appears
            // to the SPA as success and falls through to MissingConcept.
            if (importR && importR.ok === false) {
              cleanup();
              reject(new Error(importR.error || "import failed"));
              return;
            }
            conn.send({ type: "ack" });
            setTimeout(cleanup, 500);
            resolve(importR);
          } catch (e) {
            console.warn("[sinain-share:recipient] import threw:", e);
            cleanup();
            reject(e);
          }
        }
      });
    });
  }

  return { createShare, resumePeerShares, revoke, forget, connectAsRecipient };
})();

async function refreshShareBadge() {
  try {
    const r = await api("/knowledge/shares?status=waiting&status=connecting");
    const count = (r && r.shares) ? r.shares.length : 0;
    const badge = document.getElementById("shareBadge");
    if (badge) badge.textContent = count > 0 ? "(" + count + ")" : "";
  } catch {}
}

// ── Home view ─────────────────────────────────────────────────────────────
async function renderHome() {
  document.title = "Sinain Knowledge";
  const root = $("#root");
  root.innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading bookmarks…</div>';

  const [favs, recents, archives] = await Promise.all([
    api("/knowledge/bookmarks?status=favorite&limit=50"),
    api("/knowledge/bookmarks?status=recent&limit=20"),
    api("/knowledge/bookmarks?status=archive&limit=50"),
  ]);

  root.innerHTML = \`
    <h1>Knowledge</h1>
    \${renderBookmarkRow("★ Favorites", favs.bookmarks ?? [])}
    \${renderBookmarkRow("📚 Recent", recents.bookmarks ?? [])}
    \${renderBookmarkRow("🗄 Archive", archives.bookmarks ?? [])}
    <h2>Import a concept</h2>
    <div class="dropzone" id="homeDropzone">
      Drop a <code>.sinain-concept.json</code> file here, or click to choose.
      <input type="file" id="homeFileInput" accept=".json,.sinain-concept.json"
             style="display:none" />
    </div>
  \`;
  bindDropzone($("#homeDropzone"), $("#homeFileInput"));
}

function renderBookmarkRow(label, items) {
  const cards = items.length === 0
    ? '<div class="empty-row">— none yet —</div>'
    : items.map(b => \`
        <div class="bookmark-card" onclick="navigate('/knowledge/ui/entity/' + encodeURIComponent('\${esc(b.entity_id)}'))">
          <div class="entity">\${esc(b.entity_id)}</div>
          <div class="meta">\${b.note ? esc(b.note) + ' · ' : ''}visited \${timeAgo(b.last_visited)}</div>
        </div>\`).join("");
  return \`<div class="bookmark-row"><h2>\${label}</h2><div class="bookmark-list">\${cards}</div></div>\`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  return Math.round(diff / 86_400_000) + "d ago";
}

function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ── Shares view ───────────────────────────────────────────────────────────
async function renderSharesView() {
  document.title = "Shares · Sinain";
  const root = $("#root");
  root.innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading shares…</div>';

  const r = await api("/knowledge/shares?include_archived=1");
  const shares = (r && r.shares) || [];
  refreshShareBadge();

  if (shares.length === 0) {
    root.innerHTML = \`
      <h1>Shares</h1>
      <div class="empty-row" style="padding:24px;">
        No shares yet. Open an entity page and click 📤 Share to create one.
      </div>\`;
    return;
  }

  root.innerHTML = '<h1>Shares</h1><div class="shares-list" id="sharesList"></div>';
  const list = $("#sharesList");
  list.innerHTML = shares.map(renderShareRow).join("");

  // Wire per-row actions via event delegation
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const token = btn.dataset.token;
    const action = btn.dataset.action;
    const share = shares.find(s => s.share_token === token);
    if (!share) return;
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(share.url);
        showToast("✓ URL copied");
      } catch {
        showToast("Copy failed — your browser may block clipboard access");
      }
    } else if (action === "revoke") {
      if (share.mode === "fragment") {
        const ok = confirm(
          "Mark this share as revoked?\\n\\n" +
          "Note: the URL is self-contained — anyone who already has it can still import. " +
          "This only removes it from your active list.");
        if (!ok) return;
      }
      await ShareManager.revoke(token);
      renderSharesView();
    } else if (action === "forget") {
      const ok = confirm("Remove this share from your list permanently?");
      if (!ok) return;
      await ShareManager.forget(token);
      renderSharesView();
    } else if (action === "open") {
      navigate("/knowledge/ui/entity/" + encodeURIComponent(share.entity_id));
    }
  });
}

function renderShareRow(s) {
  const isPeer = s.mode === "peer";
  const statusClass = "pill-" + (s.mode === "fragment" && s.status === "delivered" ? "permanent" : s.status);
  const statusLabel = s.mode === "fragment" && s.status === "delivered" ? "permanent" : s.status;
  const pulsing = (s.status === "waiting" || s.status === "connecting") ? " pulse" : "";
  const icon = ({
    waiting: "⏳", connecting: "⚡", delivered: isPeer ? "✓" : "📎",
    disconnected: "⚠", revoked: "✕", expired: "⌛"
  })[s.status] || "•";

  const sub = [];
  sub.push(timeAgo(s.created_at));
  if (s.bundle_size != null) sub.push(fmtBytes(s.bundle_size));
  if (isPeer) sub.push("PEER"); else sub.push("LINK");
  if (s.delivered_at) sub.push("delivered " + timeAgo(s.delivered_at));
  if (s.recipient_hint) sub.push(s.recipient_hint);

  // Per-mode actions: peer has Revoke (real); fragment has Revoke (best-effort)
  // and both have Copy + Forget.
  const showRevoke = (s.status === "waiting" || s.status === "connecting" || s.status === "disconnected"
                     || (s.mode === "fragment" && s.status === "delivered"));
  return \`
    <div class="share-row\${pulsing}">
      <div class="icon">\${icon}</div>
      <div class="body">
        <div class="title" onclick="navigate('/knowledge/ui/entity/' + encodeURIComponent('\${esc(s.entity_id)}'))" style="cursor:pointer">
          \${esc(s.entity_id)}
        </div>
        <div class="meta">\${sub.map(esc).join(" · ")}</div>
      </div>
      <div class="actions">
        <span class="pill \${statusClass}">\${esc(statusLabel)}</span>
        <button data-action="copy" data-token="\${esc(s.share_token)}" title="Copy share URL">📋</button>
        \${showRevoke ? \`<button data-action="revoke" data-token="\${esc(s.share_token)}" title="\${isPeer ? 'Revoke this share (recipient will see source offline)' : 'Mark revoked (URL still works for anyone who has it)'}">✕</button>\` : ""}
        <button data-action="forget" data-token="\${esc(s.share_token)}" title="Remove from list">🗑</button>
      </div>
    </div>\`;
}

// ── Search ────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = $("#search");
  const dropdown = $("#searchResults");
  const handleQuery = debounce(async () => {
    const q = input.value.trim();
    if (!q) { dropdown.classList.remove("open"); dropdown.innerHTML = ""; return; }
    const result = await api("/knowledge/search?q=" + encodeURIComponent(q) + "&limit=15");
    // Always show "Search: query" as first option → topic page with combined recall
    const topicLink = \`
      <div class="search-result" onclick="navigate('/knowledge/ui/topic/' + encodeURIComponent('\${esc(q)}'))" style="border-bottom:1px solid rgba(255,255,255,0.1)">
        <div class="entity">🔍 Search: \${esc(q)}</div>
        <div class="snippet">Combined query — find facts across multiple entities</div>
      </div>\`;
    if (!result.results || result.results.length === 0) {
      dropdown.innerHTML = topicLink;
    } else {
      dropdown.innerHTML = topicLink + result.results.map(r => \`
        <div class="search-result" onclick="navigate('/knowledge/ui/entity/' + encodeURIComponent('\${esc(r.entity)}'))">
          <div class="entity">\${esc(r.entity)}</div>
          <div class="meta">\${esc(r.type)} · \${r.fact_count} fact\${r.fact_count === 1 ? "" : "s"}</div>
          <div class="snippet">\${esc(r.snippet || "")}</div>
        </div>\`).join("");
    }
    dropdown.classList.add("open");
  }, 220);
  input.addEventListener("input", handleQuery);
  input.addEventListener("focus", () => { if (input.value) handleQuery(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      dropdown.classList.remove("open");
      navigate("/knowledge/ui/topic/" + encodeURIComponent(input.value.trim()));
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) dropdown.classList.remove("open");
  });
}

// ── Entity page ───────────────────────────────────────────────────────────
async function renderEntityPage(entity) {
  document.title = entity + " · Sinain";
  const root = $("#root");
  root.innerHTML = \`<div class="loading-block"><span class="spinner"></span> Loading \${esc(entity)}…</div>\`;

  // Auto-import path for share links — runs BEFORE the local existence check
  // so a recipient with no prior data on this entity gets the page populated.
  // We KEEP the hash on failure so a refresh retries; only strip on success.
  let shareError = null;
  let shareMode = null;
  if (location.hash.startsWith("#bundle=")) {
    shareMode = "bundle";
    try {
      const json = await ungzipBase64(location.hash.slice("#bundle=".length));
      await api("/knowledge/concepts/import?conflict=merge", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: json
      });
      showToast("✓ Concept imported");
      history.replaceState({}, "", location.pathname);  // strip on success only
    } catch (e) {
      shareError = (e && e.message) || "decode error";
    }
  } else if (location.hash.startsWith("#peer=")) {
    shareMode = "peer";
    const token = location.hash.slice("#peer=".length);
    try {
      await ShareManager.connectAsRecipient(token);
      showToast("✓ Concept imported via peer");
      history.replaceState({}, "", location.pathname);  // strip on success only
    } catch (e) {
      shareError = (e && e.message) || "unreachable";
    }
  }

  const page = await api("/knowledge/page?entity=" + encodeURIComponent(entity));
  if (!page.ok || page.fact_count === 0) {
    // If a share-import was attempted and failed AND we have no local data,
    // render an explicit share-failed view rather than the generic
    // MissingConcept page — the user needs to know the share didn't land,
    // not just that the entity is absent.
    if (shareError && page.fact_count === 0) {
      renderShareFailed(entity, shareMode, shareError, root);
      return;
    }
    if (page.fact_count === 0) {
      renderMissingConcept(entity, root);
      return;
    }
    root.innerHTML = \`<div class="error-block">Failed to load: \${esc(page.error || "unknown")}</div>\`;
    return;
  }

  const factCount = page.fact_count;
  const facts = collectFactsFromSections(page.sections || []);

  root.innerHTML = \`
    <div class="page-header">
      <div class="title">\${esc(entity)}</div>
      <div class="badges">
        <span class="badge">\${factCount} fact\${factCount === 1 ? "" : "s"}</span>
        \${page.stats?.from_cache ? '<span class="badge">cached</span>' : '<span class="badge">fresh</span>'}
      </div>
      <div class="page-actions">
        <button id="bmFavorite" class="icon" title="Favorite">★</button>
        <button id="bmArchive" class="icon" title="Archive">🗄</button>
        <button id="actRefresh" class="icon" title="Re-render">↻</button>
        <button id="actCopyLink" class="icon" title="Copy entity URL (recipient needs same data)">🔗</button>
        <button id="actShare" class="icon" title="Share concept (auto-imports for recipient)">📤</button>
        <button id="actExport" class="icon" title="Download bundle file (manual transfer)">⬇</button>
      </div>
    </div>
    <div class="layout-3col">
      <aside><div id="treeRoot" class="tree"></div></aside>
      <div>
        \${page.summary ? \`<div class="summary">\${esc(page.summary)}</div>\` : ""}
        <div id="sectionsRoot">\${(page.sections || []).map((s, i) => renderSection(s, i)).join("")}</div>
        <div class="raw-accordion">
          <div class="raw-toggle" onclick="this.nextElementSibling.classList.toggle('open')">
            ▸ Show all \${factCount} raw fact\${factCount === 1 ? "" : "s"}
          </div>
          <div class="raw-list">\${facts.map(f => \`
            <div class="raw-item">[\${esc(f.fact_id)}] (conf=\${f.confidence}, \${esc(f.domain || "")}): \${esc(f.text || "")}</div>
          \`).join("")}</div>
        </div>
      </div>
      <aside class="meta-panel">
        <h3>Stats</h3>
        <div class="stat-row"><span class="stat-label">Facts</span><span class="stat-value">\${factCount}</span></div>
        <div class="stat-row"><span class="stat-label">Used</span><span class="stat-value">\${page.facts_used ?? factCount}</span></div>
        <div class="stat-row"><span class="stat-label">Tx watermark</span><span class="stat-value">\${page.tx_watermark}</span></div>
        \${page.stats?.tokens_in ? \`<div class="stat-row"><span class="stat-label">Tokens in</span><span class="stat-value">\${page.stats.tokens_in}</span></div>\` : ""}
        \${page.stats?.tokens_out ? \`<div class="stat-row"><span class="stat-label">Tokens out</span><span class="stat-value">\${page.stats.tokens_out}</span></div>\` : ""}
        \${page.stats?.dropped_bullets ? \`<div class="stat-row"><span class="stat-label">Dropped (LLM)</span><span class="stat-value">\${page.stats.dropped_bullets}</span></div>\` : ""}
      </aside>
    </div>\`;

  // Wire actions
  $("#bmFavorite").onclick = () => bookmarkAction(entity, "favorite");
  $("#bmArchive").onclick = () => bookmarkAction(entity, "archive");
  $("#actRefresh").onclick = () => refreshPage(entity);
  $("#actCopyLink").onclick = () => copyLink(entity);
  $("#actShare").onclick = () => shareEntity(entity);
  $("#actExport").onclick = () => exportConcept(entity);

  // Wire bullet retraction (event delegation)
  $("#sectionsRoot").addEventListener("click", (e) => {
    const more = e.target.closest(".more");
    if (more) {
      const factId = more.dataset.factId;
      openRetractModal(factId, more.closest(".bullet"), entity);
    }
  });

  // Tree
  loadTreeChildren(entity, $("#treeRoot"), 0);
}

function collectFactsFromSections(sections) {
  const out = [];
  for (const s of sections) {
    for (const b of s.bullets || []) out.push(b);
  }
  return out;
}

function renderSection(s, idx) {
  return \`
    <div class="section" id="sec-\${idx}">
      <div class="section-heading" onclick="this.parentElement.classList.toggle('collapsed')">
        \${esc(s.heading || "Untitled")}
      </div>
      \${s.notes ? \`<div class="notes">⚠ \${esc(s.notes)}</div>\` : ""}
      <ul class="bullets">\${(s.bullets || []).map(b => \`
        <li class="bullet" data-fact-id="\${esc(b.fact_id)}">
          <span class="text">\${esc(b.text || "")}</span>
          <span class="conf">\${b.confidence != null ? Number(b.confidence).toFixed(2) : ""}</span>
          <span class="fid" title="\${esc(b.fact_id)}">[\${esc((b.fact_id || "").slice(0, 16))}…]</span>
          <span class="more" data-fact-id="\${esc(b.fact_id)}" title="More">⋯</span>
        </li>\`).join("")}</ul>
    </div>\`;
}

// ── Tree (graph children) ─────────────────────────────────────────────────
async function loadTreeChildren(entity, container, depth) {
  if (depth > 3) {
    container.innerHTML = '<div class="empty-row">depth limit</div>';
    return;
  }
  const result = await api("/knowledge/graph/children?entity=" + encodeURIComponent(entity));
  if (!result.groups || result.groups.length === 0) {
    container.innerHTML = '<div class="empty-row">no children</div>';
    return;
  }
  container.innerHTML = result.groups.map(g => \`
    <div class="tree-group">
      <div class="tree-group-label">\${esc(g.label)} (\${g.children.length})</div>
      \${g.children.map(c => {
        // Prefer the fact's own value text as the visible label; entity_id
        // slugs are opaque to humans. Show the slug only when no snippet.
        const label = c.snippet || c.entity.split(":").pop() || c.entity;
        return \`
        <div class="tree-node \${c.expandable ? 'expandable' : ''}" data-entity="\${esc(c.entity)}" title="\${esc(c.entity)}">
          \${esc(label.length > 36 ? label.slice(0, 36) + "…" : label)}
        </div>
        <div class="tree-children" data-parent="\${esc(c.entity)}" style="display:none"></div>\`;
      }).join("")}
    </div>\`).join("");
  // Wire expand
  container.querySelectorAll(".tree-node").forEach(node => {
    node.addEventListener("click", async () => {
      const eid = node.dataset.entity;
      const child = container.querySelector('[data-parent="' + CSS.escape(eid) + '"]');
      if (node.classList.contains("expanded")) {
        node.classList.remove("expanded");
        child.style.display = "none";
      } else if (node.classList.contains("expandable")) {
        node.classList.add("expanded");
        child.style.display = "block";
        if (!child.dataset.loaded) {
          child.dataset.loaded = "1";
          await loadTreeChildren(eid, child, depth + 1);
        }
      } else {
        navigate("/knowledge/ui/entity/" + encodeURIComponent(eid));
      }
    });
  });
}

// ── Bookmark + actions ────────────────────────────────────────────────────
async function bookmarkAction(entity, status) {
  const r = await api("/knowledge/bookmarks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity, status }),
  });
  if (r.ok) showToast(\`✓ \${status === "favorite" ? "Favorited" : "Archived"}\`);
  else showToast("Failed: " + (r.error || "unknown"));
}

async function refreshPage(entity) {
  showToast(\`<span class="spinner"></span> Re-rendering…\`);
  await api("/knowledge/page?refresh=1&entity=" + encodeURIComponent(entity));
  render();
}

function copyLink(entity) {
  const url = location.origin + "/knowledge/ui/entity/" + encodeURIComponent(entity);
  navigator.clipboard.writeText(url).then(
    () => showToast("✓ Link copied. Recipient needs the concept imported."),
    () => showToast("Copy failed — your browser may block clipboard access"),
  );
}

async function exportConcept(entity) {
  // Simple export — no preflight dialog in v1, sensible defaults.
  const url = "/knowledge/concepts/export?entity=" + encodeURIComponent(entity)
    + "&depth=1&include_page=1";
  const a = document.createElement("a");
  a.href = url;
  a.download = entity.replace(/[^a-z0-9-]/gi, "-") + ".sinain-concept.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("✓ Exporting concept bundle…");
}

async function shareEntity(entity) {
  showToast('<span class="spinner"></span> Preparing share…', 30_000);
  try {
    await ShareManager.createShare(entity);
    // Toast + clipboard already handled by ShareManager. User can navigate
    // freely; status is visible in the Shares view.
  } catch (e) {
    showToast("Share failed: " + (e && e.message ? e.message : String(e)));
  }
}

// ── Retraction modal + undo toast ─────────────────────────────────────────
function openRetractModal(factId, bulletEl, sourceEntity) {
  const text = bulletEl.querySelector(".text").textContent;
  const conf = bulletEl.querySelector(".conf").textContent;
  const root = $("#modalRoot");
  root.innerHTML = \`
    <div class="modal-backdrop open" id="retractModal">
      <div class="modal">
        <h2>Retract this fact?</h2>
        <div class="quote">\${esc(text)}</div>
        <div class="body">Confidence \${esc(conf)} · Fact id <code>\${esc(factId)}</code></div>
        <label>Reason (optional)</label>
        <textarea id="retractReason" placeholder="Why are you retracting this?"></textarea>
        <div class="modal-actions">
          <button onclick="closeModal()">Cancel</button>
          <button class="primary danger" id="retractGo">Retract</button>
        </div>
      </div>
    </div>\`;
  $("#retractGo").onclick = async () => {
    const reason = $("#retractReason").value.trim() || null;
    closeModal();
    bulletEl.classList.add("retracting");
    const r = await api("/knowledge/facts/" + encodeURIComponent(factId), {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, actor: "web-ui", source_entity: sourceEntity }),
    });
    if (r.ok) {
      setTimeout(() => bulletEl.remove(), 300);
      showUndoToast(factId, r.undo_token, sourceEntity);
    } else {
      bulletEl.classList.remove("retracting");
      showToast("Retract failed: " + (r.error || "unknown"));
    }
  };
}
function closeModal() { $("#modalRoot").innerHTML = ""; }

function showToast(html, ms = 4000) {
  const root = $("#toastRoot");
  root.innerHTML = \`<div class="toast"><div class="text">\${html}</div></div>\`;
  setTimeout(() => { if (root.innerHTML.includes(html)) root.innerHTML = ""; }, ms);
}

function showUndoToast(factId, undoToken, sourceEntity) {
  const root = $("#toastRoot");
  const ms = 10_000;
  root.innerHTML = \`
    <div class="toast" id="undoToast">
      <span class="icon">✓</span>
      <span class="text">Retracted</span>
      <button id="undoBtn">Undo</button>
      <div class="timer" style="width:100%; transition: width \${ms}ms linear;"></div>
    </div>\`;
  // Animate timer
  requestAnimationFrame(() => { $("#undoToast .timer").style.width = "0%"; });
  $("#undoBtn").onclick = async () => {
    root.innerHTML = "";
    const r = await api("/knowledge/facts/" + encodeURIComponent(factId) + "/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ undo_token: undoToken }),
    });
    if (r.ok) {
      showToast("✓ Restored — reload to see");
    } else {
      showToast("Restore failed: " + (r.error || "unknown"));
    }
  };
  setTimeout(() => { if ($("#undoToast")) root.innerHTML = ""; }, ms);
}

// ── Share-failed landing ──────────────────────────────────────────────────
// Shown when a #bundle= or #peer= share-link couldn't be imported AND no
// local data exists for the entity. Distinct from MissingConcept because
// the user explicitly tried to load shared data — they need to know that
// transfer failed, not just that the entity isn't here.
function renderShareFailed(entity, mode, errorMsg, root) {
  document.title = "Share couldn't load · Sinain";
  const isPeer = mode === "peer";
  root.innerHTML = \`
    <h1>Share couldn't be loaded</h1>
    <div class="error-block" style="margin-bottom: 16px;">
      <strong>\${esc(entity)}</strong> — \${isPeer ? "couldn't receive bundle from sender" : "couldn't decode bundle from URL"}.
      <br><br>
      <code>\${esc(errorMsg)}</code>
    </div>
    \${isPeer ? \`
    <p style="color: var(--fg-dim); line-height: 1.5;">
      Likely causes:
    </p>
    <ul style="color: var(--fg-dim); line-height: 1.6;">
      <li>The sender's tab is closed (peer share needs sender's sinain-core open).</li>
      <li>The share has expired or was revoked.</li>
      <li>Network/NAT blocked the WebRTC connection (about 10–20% of pairs need a TURN relay).</li>
    </ul>
    <p style="color: var(--fg-dim);">
      Ask the sender to reopen sinain (their peer registration auto-resumes), then click <strong>Retry</strong>.
    </p>\` : \`
    <p style="color: var(--fg-dim); line-height: 1.5;">
      The link's <code>#bundle=…</code> portion may have been truncated by a chat tool — some preview tools strip URL fragments.
      Ask the sender to re-share, ideally pasted as a code block so the URL stays intact.
    </p>\`}
    <div class="actions" style="margin-top: 20px; display: flex; gap: 10px;">
      <button class="primary" onclick="location.reload()">Retry</button>
      <button onclick="window._proceedWithoutShare('\${esc(entity)}')">Continue without share</button>
    </div>
  \`;
  // Continue-without-share clears the hash so the next render takes the
  // normal MissingConcept path (which has the file-drop dropzone).
  window._proceedWithoutShare = (eid) => {
    history.replaceState({}, "", "/knowledge/ui/entity/" + encodeURIComponent(eid));
    renderMissingConcept(eid, root);
  };
}

// ── Missing concept landing ───────────────────────────────────────────────
function renderMissingConcept(entity, root) {
  document.title = "Missing · " + entity;
  root.innerHTML = \`
    <h1>Concept not found</h1>
    <div class="error-block" style="margin-bottom: 24px;">
      <code>\${esc(entity)}</code> is not in this machine's knowledge graph yet.
    </div>
    <p>If someone shared a <code>.sinain-concept.json</code> bundle with you, drop it here:</p>
    <div class="dropzone" id="missingDropzone">
      📥 Drop concept bundle
      <input type="file" id="missingFileInput" accept=".json,.sinain-concept.json"
             style="display:none" />
    </div>
    <p style="color: var(--fg-dim); margin-top:24px">After import, this page will load automatically.</p>
  \`;
  bindDropzone($("#missingDropzone"), $("#missingFileInput"), entity);
}

// ── Topic page (simple, v1) ───────────────────────────────────────────────
async function renderTopicPage(q) {
  document.title = "Topic: " + q + " · Sinain";
  const root = $("#root");
  root.innerHTML = \`<div class="loading-block"><span class="spinner"></span> Searching…</div>\`;

  // Parallel: get combined facts + matching entities
  const [qr, sr] = await Promise.all([
    api("/knowledge/query?q=" + encodeURIComponent(q) + "&max=30"),
    api("/knowledge/search?q=" + encodeURIComponent(q) + "&limit=10"),
  ]);
  const factsText = qr.facts_text || "";
  const entities = sr.results || [];

  if (!factsText && entities.length === 0) {
    root.innerHTML = \`
      <div class="page-header"><div class="title">Topic: \${esc(q)}</div></div>
      <div class="error-block">No matching facts.</div>\`;
    return;
  }

  // Parse compact facts into structured items, group by entity
  const factItems = factsText ? factsText.split("; ").filter(Boolean) : [];
  const grouped = {};
  const ungrouped = [];
  for (const f of factItems) {
    const m = f.match(/^([^:]*?):\\s*(.+?)\\s*\\(([^)]+)\\)$/);
    if (m) {
      const ent = m[1].trim() || "general";
      (grouped[ent] = grouped[ent] || []).push({text: m[2], meta: m[3], raw: f});
    } else {
      ungrouped.push({text: f, meta: "", raw: f});
    }
  }

  // Build summary from top entities
  const topEnts = Object.keys(grouped).slice(0, 5).join(", ");
  const summary = factItems.length > 0
    ? \`\${factItems.length} facts retrieved across \${Object.keys(grouped).length} entities\${topEnts ? ": " + topEnts : ""}\`
    : "No facts found for this query.";

  root.innerHTML = \`
    <div class="page-header">
      <div class="title">Topic: \${esc(q)}</div>
      <div class="badges">
        <span class="badge">\${factItems.length} fact\${factItems.length === 1 ? "" : "s"}</span>
        <span class="badge">\${Object.keys(grouped).length} entit\${Object.keys(grouped).length === 1 ? "y" : "ies"}</span>
      </div>
      <div class="page-actions">
        <button id="topicCopyLink" class="icon" title="Copy topic URL">🔗</button>
        <button id="topicShare" class="icon" title="Share topic (auto-imports for recipient)">📤</button>
      </div>
    </div>
    <div class="summary">\${esc(summary)}</div>
    <div id="topicSections">
      \${Object.entries(grouped).map(([ent, facts], i) => \`
        <div class="section" id="sec-\${i}">
          <div class="section-heading" onclick="this.parentElement.classList.toggle('collapsed')">
            \${esc(ent)}
            <span style="opacity:0.5;font-size:0.85em;margin-left:8px">\${facts.length} fact\${facts.length === 1 ? "" : "s"}</span>
          </div>
          <ul class="bullets">\${facts.map(f => \`
            <li class="bullet">
              <span class="text">\${esc(f.text)}</span>
              <span class="conf">\${esc(f.meta)}</span>
            </li>\`).join("")}</ul>
        </div>\`).join("")}
      \${ungrouped.length > 0 ? \`
        <div class="section">
          <div class="section-heading">Other</div>
          <ul class="bullets">\${ungrouped.map(f => \`
            <li class="bullet"><span class="text">\${esc(f.text)}</span></li>\`).join("")}</ul>
        </div>\` : ""}
    </div>
    \${entities.length > 0 ? \`
      <div class="section" style="margin-top:16px">
        <div class="section-heading" onclick="this.parentElement.classList.toggle('collapsed')">
          Related Entities
        </div>
        <ul class="bullets">\${entities.map(rr => \`
          <li class="bullet" onclick="navigate('/knowledge/ui/entity/' + encodeURIComponent('\${esc(rr.entity)}'))" style="cursor:pointer">
            <span class="text"><strong>\${esc(rr.entity)}</strong> — \${esc(rr.snippet || "")}</span>
            <span class="conf">\${rr.fact_count} fact\${rr.fact_count === 1 ? "" : "s"}</span>
          </li>\`).join("")}</ul>
      </div>\` : ""}\`;

  // Wire actions
  $("#topicCopyLink").onclick = () => {
    const url = location.origin + "/knowledge/ui/topic/" + encodeURIComponent(q);
    navigator.clipboard.writeText(url);
    showToast("✓ Link copied");
  };
  $("#topicShare").onclick = async () => {
    // Share all entities mentioned in the query
    const ents = (qr.entities || q.split(/[\\s,+]+/)).filter(Boolean);
    if (ents.length === 0) { showToast("No entities to share"); return; }
    showToast('<span class="spinner"></span> Preparing share…', 30_000);
    try {
      for (const ent of ents.slice(0, 3)) {
        await ShareManager.createShare(ent);
      }
    } catch (e) {
      showToast("Share failed: " + (e && e.message ? e.message : String(e)));
    }
  };
}

// ── Dropzone wiring (shared) ──────────────────────────────────────────────
function bindDropzone(zone, input, redirectAfter) {
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => importFiles(e.target.files, redirectAfter));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    importFiles(e.dataTransfer.files, redirectAfter);
  });
}

function setupGlobalDrop() {
  // Prevent navigation when files dropped outside the dropzone.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (e.target.closest(".dropzone")) return;
    e.preventDefault();
  });
}

async function importFiles(files, redirectAfter) {
  if (!files || files.length === 0) return;
  const file = files[0];
  showToast(\`<span class="spinner"></span> Importing \${esc(file.name)}…\`, 30_000);
  const text = await file.text();
  let envelope;
  try { envelope = JSON.parse(text); } catch (e) {
    showToast("Import failed: not valid JSON");
    return;
  }
  const r = await api("/knowledge/concepts/import?conflict=merge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (r.ok) {
    const stats = r.stats || {};
    showToast(\`✓ Imported \${stats.triples_inserted || 0} triple\${stats.triples_inserted === 1 ? "" : "s"}\` +
              (stats.triples_skipped_duplicate ? \` (\${stats.triples_skipped_duplicate} dupes skipped)\` : ""));
    const target = r.root_entity || redirectAfter;
    if (target) navigate("/knowledge/ui/entity/" + encodeURIComponent(target));
    else render();
  } else {
    showToast("Import failed: " + (r.error || "unknown"));
  }
}
</script>
</body></html>`;

/**
 * Render the V2 SPA HTML with env-var-driven config substituted in.
 * The placeholders `__SHARE_PEERJS_HOST__` etc. are inert in the source
 * template; we replace them at serve time so the SPA can read the values
 * without an extra `/knowledge/share/config` round-trip on load.
 */
function renderKnowledgeUiV2(): string {
  const peerHost = process.env.SINAIN_PEERJS_HOST || "";  // empty = peerjs.com cloud default
  const inlineMax = parseInt(process.env.SINAIN_SHARE_INLINE_MAX_BYTES || "6000");
  const ttlHours = parseInt(process.env.SINAIN_SHARE_TTL_HOURS || "24");
  // Public URL of the share-redirector. Self-hosted on the existing
  // sinain.duckdns.org Caddy + Let's Encrypt setup that already fronts the
  // OpenClaw gateway. We control the host, headers, and reliability — no
  // CDN policy quirks (jsDelivr serves gh-path HTML as text/plain;
  // raw.githack.com returns 403 with body). Browsers preserve URL fragments
  // through redirects without sending them to the server, so bundle bytes
  // in #bundle=… never touch our host either.
  const shareBaseUrl = process.env.SINAIN_SHARE_BASE_URL
    || "https://sinain.duckdns.org/share.html";
  return KNOWLEDGE_UI_V2_HTML
    .replace(/__SHARE_PEERJS_HOST__/g, JSON.stringify(peerHost))
    .replace(/__SHARE_INLINE_MAX_BYTES__/g, String(inlineMax))
    .replace(/__SHARE_TTL_HOURS__/g, String(ttlHours))
    .replace(/__SHARE_BASE_URL__/g, JSON.stringify(shareBaseUrl));
}

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
  /** Export a concept bundle (entity + neighborhood) for transfer between machines. */
  exportConcept?: (entity: string, depth: number, opts: { includeRetracted: boolean; includePage: boolean; redactRules: string[] }) => Promise<unknown>;
  /** Import a concept bundle into the local knowledge graph. */
  importConcept?: (envelope: unknown, conflict: "skip" | "merge" | "overwrite") => Promise<unknown>;

  /** Bare-agent announced its roster on startup. */
  registerBareAgent?: (available: string[], current: string) => void;
  /** Current per-lane agent choice; read by run.sh via the piggyback field
   *  on /escalation/pending and /spawn/pending responses, and by manual
   *  debug via GET /bareagent/config. `registered` distinguishes "user
   *  chose Off" (registered=true, lanes="") from "core forgot our
   *  registration" (registered=false) so run.sh heals only on the latter. */
  getBareAgentConfig?: () => { escalationAgent: string; spawnAgent: string; registered: boolean };
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

      // New "living Confluence" SPA — search-driven, LLM-rendered pages,
      // bookmarks, retraction, concept transfer.
      // Cache-Control: no-cache forces browsers to revalidate the SPA HTML
      // on every navigation. Otherwise, after a sinain-core upgrade the
      // browser serves stale SPA from cache (bugfixes don't take effect
      // until the user hard-reloads). With revalidation on, ETag mismatches
      // are detected immediately and the new SPA is loaded.
      if (req.method === "GET" && url.pathname === "/knowledge/ui") {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
        res.end(renderKnowledgeUiV2());
        return;
      }

      // SPA route handling — the SPA uses path-style entity URLs. Server-side
      // we just serve the same HTML; client-side router parses location.pathname.
      if (req.method === "GET" && url.pathname.startsWith("/knowledge/ui/")) {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
        res.end(renderKnowledgeUiV2());
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
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "", registered: false };
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
        const config = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "", registered: false };
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
        const cfg = deps.getBareAgentConfig?.() ?? { escalationAgent: "", spawnAgent: "", registered: false };
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
