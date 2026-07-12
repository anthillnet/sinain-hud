/**
 * Sinain Wiki web UI — the human view over the virtual vault
 * (docs/DESIGN-SINAIN-WIKI.md §6, visual spec: "Sinain Wiki.dc.html").
 *
 * Replaces the Living Confluence SPA at /knowledge/ui. The app is a router
 * + markdown renderer over the same GET /knowledge/<path>.md bytes every
 * other client sees, plus exactly two custom render rules:
 *   1. [[wikilinks]] navigate (bare target = entity slug; "/" = page path)
 *   2. ^f-<id> block anchors carry the retract/restore actions
 *
 * Single inline HTML file, zero-build — same deploy story as the previous
 * UIs. Client JS avoids template literals so the TS wrapper stays sane.
 */

export const KNOWLEDGE_WIKI_UI_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sinain Wiki</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f8fafc; --chip: #f1f5f9; --border: #e2e8f0;
    --text: #0f172a; --secondary: #475569; --muted: #94a3b8;
    --accent: #2563eb; --accent-hover: #1d4ed8; --red: #b91c1c;
    --amber: #b45309; --purple: #7c3aed; --teal: #0d9488; --green: #15803d;
    --mono: ui-monospace, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
  }
  @keyframes wkArrive { 0% { opacity:0; transform:translateY(6px);} 100% { opacity:1; transform:translateY(0);} }
  #app { display: flex; flex-direction: column; height: 100vh; }

  /* header */
  .hdr { flex: none; display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--border); }
  .logo { font-weight: 700; color: var(--accent); font-size: 16px; cursor: pointer; }
  .searchWrap { position: relative; flex: 1; max-width: 560px; }
  .searchWrap input {
    width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--border);
    padding: 9px 14px; border-radius: 6px; font: inherit; outline: none;
  }
  .searchDrop {
    position: absolute; top: 100%; left: 0; right: 0; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; margin-top: 4px; box-shadow: 0 4px 18px rgba(15,23,42,0.12); z-index: 50; overflow: hidden;
  }
  .searchRow { padding: 9px 14px; cursor: pointer; border-bottom: 1px solid var(--chip); }
  .searchRow:hover { background: var(--chip); }
  .searchRow .t { color: var(--accent); font-weight: 600; font-size: 13px; }
  .searchRow .badge { font-size: 10px; color: var(--muted); background: var(--chip); padding: 1px 6px; border-radius: 4px; margin-left: 8px; }
  .searchRow .m { color: var(--secondary); font-size: 11px; margin-top: 1px; }
  .btn {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px;
  }
  .btn:hover { border-color: var(--accent-hover); }
  .btn .n { color: var(--accent); font-weight: 600; }

  /* address strip */
  .addr { flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .addr .id { font-size: 11px; font-family: var(--mono); font-weight: 600; }
  .addr .eq { font-size: 10px; color: #cbd5e1; }
  .addr .http { font-size: 10px; font-family: var(--mono); color: var(--muted); }
  .addr .note { margin-left: auto; font-size: 10px; color: var(--muted); }

  /* body */
  .cols { flex: 1; display: flex; min-height: 0; }
  .rail { flex: none; width: 224px; border-right: 1px solid var(--border); overflow-y: auto; padding: 14px 10px; display: flex; flex-direction: column; }
  .railHdr { color: var(--accent); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 6px; margin: 0 0 4px; }
  .railGroup { margin-bottom: 14px; }
  .railNode { padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .railNode:hover { background: var(--chip); }
  .railNode.root { font-family: var(--mono); }
  .railNode.active { background: var(--chip); color: var(--accent); font-weight: 600; }
  .railFoot { border-top: 1px solid var(--border); padding-top: 10px; margin-top: auto; }
  .railFoot .hint { font-size: 10px; color: var(--muted); line-height: 13px; margin-top: 6px; padding: 0 2px; }

  .main { flex: 1; overflow-y: auto; min-width: 0; }
  .page { padding: 24px 28px; max-width: 820px; animation: wkArrive .25s ease-out; }
  .page.wide { max-width: none; }
  .pTitle { font-size: 22px; font-weight: 700; margin: 0 0 14px; }
  .pTitle.small { font-size: 20px; margin-bottom: 2px; }
  .pSub { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .chip { background: var(--chip); padding: 3px 8px; border-radius: 4px; font-size: 11px; color: var(--secondary); }
  .chip .k { color: var(--muted); }
  .chip.link { font-family: var(--mono); color: var(--accent); cursor: pointer; }
  .chip.link:hover { background: var(--border); }
  .summary { background: var(--panel); border-left: 3px solid var(--accent); padding: 14px 16px; border-radius: 0 6px 6px 0; margin-bottom: 22px; font-size: 15px; line-height: 1.55; }
  .secHdr { font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 8px; }
  .secWrap { margin-bottom: 20px; }
  .wl { color: var(--accent); font-weight: 600; cursor: pointer; }
  .wl:hover { text-decoration: underline; }
  .factRow { display: flex; gap: 12px; align-items: flex-start; padding: 7px 12px; border-radius: 6px; }
  .factRow:hover { background: var(--panel); }
  .factRow .txt { flex: 1; font-size: 14px; line-height: 1.5; }
  .factRow.retracted .txt { text-decoration: line-through; opacity: 0.45; }
  .factRow .conf { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 2px; }
  .factRow .anchor { flex: none; font-size: 10px; font-family: var(--mono); color: var(--muted); padding-top: 3px; }
  .factRow .act { flex: none; font-size: 11px; cursor: pointer; padding-top: 2px; color: var(--red); visibility: hidden; }
  .factRow:hover .act, .factRow.retracted .act { visibility: visible; }
  .factRow .act.restore { color: var(--accent); }
  .factRow .act:hover { text-decoration: underline; }
  .edgeRow { display: flex; gap: 8px; align-items: baseline; padding: 5px 12px; }
  .edgeRow .pred { font-size: 12px; font-family: var(--mono); color: var(--secondary); }
  .bulletRow { display: flex; gap: 8px; align-items: baseline; padding: 5px 12px; font-size: 13px; }
  .bulletRow .note { font-size: 12px; color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 11px 13px; cursor: pointer; }
  .card:hover { border-color: var(--accent-hover); }
  .card .t { font-weight: 600; color: var(--accent); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .m { color: var(--secondary); font-size: 11px; margin-top: 3px; }
  .grpHdr { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .grpHdr .l { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
  .grpHdr .c { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .fchips { display: flex; gap: 8px; flex-wrap: wrap; }
  .fchip { padding: 6px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--accent); font-weight: 600; }
  .fchip:hover { border-color: var(--accent-hover); }
  .drop { border: 2px dashed #cbd5e1; border-radius: 8px; padding: 26px; text-align: center; color: var(--secondary); cursor: pointer; margin-top: 8px; font-size: 13px; }
  .drop:hover, .drop.over { border-color: var(--accent); color: var(--text); }
  .logRow { display: flex; gap: 12px; align-items: baseline; padding: 9px 12px; border-radius: 6px; cursor: pointer; border-bottom: 1px solid var(--chip); }
  .logRow:hover { background: var(--panel); }
  .logRow .ts { flex: none; font-size: 11px; font-family: var(--mono); color: var(--muted); }
  .logRow .kind { flex: none; width: 82px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .logRow .sum { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .logRow .eid { flex: none; font-size: 11px; font-family: var(--mono); color: var(--accent); }
  .quote { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.6; color: var(--secondary); font-style: italic; margin-bottom: 22px; }
  .quote.answer { border: none; border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; font-style: normal; color: var(--text); font-size: 14px; }
  .shareRow { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 13px 16px; margin-bottom: 10px; cursor: pointer; }
  .shareRow:hover { border-color: var(--accent-hover); }
  .shareRow .t { font-weight: 600; color: var(--accent); font-size: 13px; }
  .shareRow .m { color: var(--secondary); font-size: 12px; margin-top: 2px; }
  .pill { padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
  .pill.delivered { background: rgba(21,128,61,0.10); color: var(--green); }
  .pill.waiting, .pill.connecting, .pill.disconnected { background: rgba(180,83,9,0.10); color: var(--amber); }
  .pill.revoked, .pill.expired { background: var(--chip); color: var(--muted); }
  .mono { font-family: var(--mono); }
  .mdP { font-size: 14px; line-height: 1.6; margin: 0 0 12px; }
  .mdBullet { padding: 5px 12px; font-size: 13px; line-height: 1.5; }
  .mdCode { background: var(--chip); border-radius: 4px; padding: 1px 5px; font-family: var(--mono); font-size: 12px; }
  .foot { font-size: 11px; color: var(--muted); font-family: var(--mono); margin-top: 12px; padding: 0 12px; }
  .empty { color: var(--muted); font-size: 13px; padding: 24px 12px; }
  .linkBox { display: inline-block; background: var(--chip); border-radius: 6px; padding: 8px 12px; font-size: 11px; font-family: var(--mono); color: var(--secondary); word-break: break-all; }
  .redaction { background: #fffbeb; border-left: 3px solid var(--amber); padding: 10px 14px; border-radius: 0 6px 6px 0; font-size: 12px; color: #78350f; margin-bottom: 14px; }
  .titleRow { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .titleRow .pTitle { margin: 0; }
  .titleBtns { margin-left: auto; display: flex; gap: 8px; }

  /* toast */
  .toast {
    position: fixed; bottom: 20px; right: 20px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 16px; box-shadow: 0 4px 18px rgba(15,23,42,0.14);
    display: flex; gap: 12px; align-items: center; min-width: 320px; max-width: 460px; z-index: 200;
    animation: wkArrive .2s ease-out; overflow: hidden;
  }
  .toast .txt { flex: 1; font-size: 13px; }
  .toast .x { font-size: 13px; color: var(--muted); cursor: pointer; }
  .toast .bar { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--accent); transition: width .3s linear; }
</style>
</head>
<body>
<div id="app">
  <div class="hdr">
    <div class="logo" id="logo">SINAIN</div>
    <div class="searchWrap">
      <input id="q" placeholder="Search entities, topics, people…" autocomplete="off">
      <div class="searchDrop" id="drop" style="display:none"></div>
    </div>
    <div style="flex:1"></div>
    <button class="btn" id="sharesBtn">Shares <span class="n" id="shareCount"></span></button>
  </div>
  <div class="addr">
    <span class="id" id="addrId"></span>
    <span class="eq">≡</span>
    <span class="http" id="addrHttp"></span>
    <span class="note">one renderer — LLM, curl and this UI see the same bytes</span>
  </div>
  <div class="cols">
    <div class="rail" id="rail"></div>
    <div class="main" id="main"></div>
  </div>
</div>
<div id="toastHost"></div>
<script>
"use strict";
var SHARE_BASE_URL = __WIKI_SHARE_BASE_URL__;
var SHARE_PEERJS_HOST = __WIKI_SHARE_PEERJS_HOST__;
var SHARE_TURN_CREDENTIALS_URL = __WIKI_SHARE_TURN_CREDENTIALS_URL__;

var $ = function (s, el) { return (el || document).querySelector(s); };
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fetchText(url) { return fetch(url).then(function (r) { return r.text(); }); }
function fetchJson(url, opts) { return fetch(url, opts).then(function (r) { return r.json(); }); }

// ── address space ────────────────────────────────────────────────────
// route = {kind, slug|id|q|token}; mdPath = path under /knowledge/
var UI_BASE = "/knowledge/ui";

function parseLocation() {
  var p = location.pathname;
  if (p.indexOf(UI_BASE) !== 0) return { kind: "index" };
  var rest = p.slice(UI_BASE.length).replace(/^\\//, "");
  if (!rest) return { kind: "index" };
  if (rest === "wiki") return { kind: "wiki" };
  if (rest === "log") return { kind: "log" };
  if (rest === "shares") return { kind: "shares" };
  if (rest === "lint") return { kind: "lint" };
  var m = rest.match(/^(entity|episode|topic|share)\\/(.+)$/);
  if (m) {
    var val = decodeURIComponent(m[2]);
    if (m[1] === "entity") return { kind: "entity", slug: val };
    if (m[1] === "episode") return { kind: "episode", id: val };
    if (m[1] === "topic") return { kind: "topic", q: val };
    if (m[1] === "share") return { kind: "share", token: val };
  }
  return { kind: "index" };
}

function routePath(route) {
  if (route.kind === "index") return "";
  if (route.kind === "wiki") return "wiki";
  if (route.kind === "log") return "log";
  if (route.kind === "shares") return "shares";
  if (route.kind === "lint") return "lint";
  if (route.kind === "entity") return "entity/" + encodeURIComponent(route.slug);
  if (route.kind === "episode") return "episode/" + encodeURIComponent(route.id);
  if (route.kind === "topic") return "topic/" + encodeURIComponent(route.q);
  if (route.kind === "share") return "share/" + encodeURIComponent(route.token);
  return "";
}

function mdPath(route) {
  if (route.kind === "index") return "index.md";
  if (route.kind === "wiki") return "WIKI.md";
  if (route.kind === "log") return "log.md";
  if (route.kind === "shares") return "shares.md";
  if (route.kind === "lint") return "lint.md";
  if (route.kind === "entity") return "entity/" + encodeURIComponent(route.slug) + ".md";
  if (route.kind === "episode") return "episode/" + encodeURIComponent(route.id) + ".md";
  if (route.kind === "topic") return "topic/" + encodeURIComponent(route.q) + ".md";
  if (route.kind === "share") return "share/" + encodeURIComponent(route.token) + ".md";
  return "index.md";
}

var state = { route: parseLocation(), retracted: {}, undoTokens: {} };

function navigate(route) {
  state.route = route;
  var path = routePath(route);
  history.pushState({}, "", UI_BASE + (path ? "/" + path : ""));
  render();
}
window.addEventListener("popstate", function () { state.route = parseLocation(); render(); });

// wikilink target → route. Bare = entity slug; "/" = address-space path.
function linkRoute(target) {
  var m = target.match(/^(episode|topic|share|entity)\\/(.+)$/);
  if (m) {
    if (m[1] === "episode") return { kind: "episode", id: m[2] };
    if (m[1] === "topic") return { kind: "topic", q: m[2] };
    if (m[1] === "share") return { kind: "share", token: m[2] };
    return { kind: "entity", slug: m[2] };
  }
  if (target === "WIKI.md" || target === "AGENTS.md") return { kind: "wiki" };
  if (target === "index.md") return { kind: "index" };
  if (target === "log.md") return { kind: "log" };
  if (target === "shares.md") return { kind: "shares" };
  if (target === "lint.md") return { kind: "lint" };
  return { kind: "entity", slug: target };
}

// anchor body ("f-xyz") → fact id ("fact:xyz"); mirror of pages.ts.
function anchorToFact(anchor) {
  var body = anchor.indexOf("f-") === 0 ? anchor.slice(2) : anchor;
  if (body.indexOf("__") >= 0) return body.replace("__", ":");
  if (body.indexOf(":") >= 0) return body;
  return "fact:" + body;
}

// ── markdown parsing (frontmatter + sections + tokens) ───────────────
function parseMd(md) {
  var doc = { fm: {}, title: "", sections: [], intro: [] };
  var lines = md.split("\\n");
  var i = 0;
  if (lines[0] === "---") {
    i = 1;
    for (; i < lines.length && lines[i] !== "---"; i++) {
      var kv = lines[i].match(/^([A-Za-z_][\\w-]*):\\s*(.*)$/);
      if (kv) {
        var v = kv[2].trim();
        if (v.charAt(0) === "[" && v.charAt(v.length - 1) === "]") {
          doc.fm[kv[1]] = v.slice(1, -1).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        } else doc.fm[kv[1]] = v;
      }
    }
    i++;
  }
  var current = null; // section
  for (; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    var h1 = line.match(/^#\\s+(.*)$/);
    if (h1) { doc.title = h1[1]; continue; }
    var h2 = line.match(/^##\\s+(.*)$/);
    if (h2) { current = { heading: h2[1], items: [] }; doc.sections.push(current); continue; }
    var item;
    var bullet = line.match(/^-\\s+(.*)$/);
    if (bullet) item = parseBullet(bullet[1]);
    else if (line.charAt(0) === ">") item = { type: "quote", text: line.replace(/^>\\s?/, "") };
    else if (line.match(/^\\*[^*].*\\*$/)) item = { type: "foot", text: line.slice(1, -1) };
    else item = { type: "para", text: line };
    if (current) current.items.push(item);
    else doc.intro.push(item);
  }
  return doc;
}

function parseBullet(text) {
  var item = { type: "bullet", text: text, anchor: null, conf: null, pred: null, ts: null, kind: null };
  var am = item.text.match(/\\s\\^([\\w-]+(?:__[\\w-]+)?)\\s*$/);
  if (am) { item.anchor = am[1]; item.text = item.text.slice(0, am.index); }
  var cm = item.text.match(/\\s·\\s*conf\\s+([\\d.]+)\\s*$/);
  if (cm) { item.conf = cm[1]; item.text = item.text.slice(0, cm.index); }
  var tm = item.text.match(/^\\[([^\\]]+)\\]\\s+\\*\\*(\\w+)\\*\\*\\s+(.*)$/); // log rows
  if (tm) { item.ts = tm[1]; item.kind = tm[2]; item.text = tm[3]; }
  var pm = item.text.match(/^([\\w-]+)::\\s+(.*)$/); // typed edge
  if (pm) { item.pred = pm[1]; item.text = pm[2]; }
  return item;
}

// text → tokens: wikilinks / bold / code / strike / plain.
function tokenize(text) {
  var out = [];
  var re = /\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]|\\*\\*([^*]+)\\*\\*|\`([^\`]+)\`|~~([^~]+)~~/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: m[2] || m[1], link: m[1] });
    else if (m[3] !== undefined) out.push({ t: m[3], bold: true });
    else if (m[4] !== undefined) out.push({ t: m[4], code: true });
    else out.push({ t: m[5], strike: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

function renderTokens(container, text) {
  tokenize(text).forEach(function (tk) {
    if (tk.link) {
      var a = el("span", "wl", tk.t);
      a.onclick = function (ev) { ev.stopPropagation(); navigate(linkRoute(tk.link)); };
      container.appendChild(a);
    } else if (tk.bold) container.appendChild(el("strong", "", tk.t));
    else if (tk.code) container.appendChild(el("span", "mdCode", tk.t));
    else if (tk.strike) container.appendChild(el("del", "", tk.t));
    else container.appendChild(document.createTextNode(tk.t));
  });
}

// ── toast ────────────────────────────────────────────────────────────
var toastTimer = null;
function clearToast() {
  if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
  $("#toastHost").innerHTML = "";
}
function showToast(text, undoFn) {
  clearToast();
  var host = $("#toastHost");
  var t = el("div", "toast");
  t.appendChild(el("span", "txt", text));
  var total = 8, left = total;
  var undoBtn = null;
  if (undoFn) {
    undoBtn = el("button", "btn", "Undo · " + left + "s");
    undoBtn.onclick = function () { clearToast(); undoFn(); };
    t.appendChild(undoBtn);
  }
  var x = el("span", "x", "✕");
  x.onclick = clearToast;
  t.appendChild(x);
  var bar = el("div", "bar");
  bar.style.width = "100%";
  t.appendChild(bar);
  host.appendChild(t);
  toastTimer = setInterval(function () {
    left--;
    if (left <= 0) { clearToast(); return; }
    if (undoBtn) undoBtn.textContent = "Undo · " + left + "s";
    bar.style.width = Math.round(left / total * 100) + "%";
  }, 1000);
}

// ── retract / restore ────────────────────────────────────────────────
function retractFact(row, anchor, sourceEntity) {
  var factId = anchorToFact(anchor);
  fetchJson("/knowledge/facts/" + encodeURIComponent(factId), {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: null, actor: "web-ui", source_entity: sourceEntity }),
  }).then(function (r) {
    if (!r.ok) { showToast("Retract failed: " + (r.error || "unknown")); return; }
    state.retracted[anchor] = true;
    state.undoTokens[anchor] = r.undo_token;
    styleFactRow(row, anchor, sourceEntity);
    showToast("Retracted ^" + anchor + " — bi-temporal: the store keeps the truth, the page drops the claim.",
      function () { restoreFact(row, anchor, sourceEntity); });
  }).catch(function (e) { showToast("Retract failed: " + e); });
}
function restoreFact(row, anchor, sourceEntity) {
  var factId = anchorToFact(anchor);
  fetchJson("/knowledge/facts/" + encodeURIComponent(factId) + "/restore", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ undo_token: state.undoTokens[anchor] || null }),
  }).then(function (r) {
    if (!r.ok) { showToast("Restore failed: " + (r.error || "unknown")); return; }
    delete state.retracted[anchor];
    delete state.undoTokens[anchor];
    styleFactRow(row, anchor, sourceEntity);
    clearToast();
  }).catch(function (e) { showToast("Restore failed: " + e); });
}
function styleFactRow(row, anchor, sourceEntity) {
  var isR = !!state.retracted[anchor];
  row.classList.toggle("retracted", isR);
  var act = row.querySelector(".act");
  act.textContent = isR ? "restore" : "retract";
  act.className = "act" + (isR ? " restore" : "");
  act.onclick = function () {
    if (state.retracted[anchor]) restoreFact(row, anchor, sourceEntity);
    else retractFact(row, anchor, sourceEntity);
  };
}

// ── sharing (peerjs live transfer — the only bundle transport) ───────
// Bundles never ride inside links: the link carries only #peer=<token>,
// the recipient dials the token and the bundle streams peer-to-peer over
// WebRTC (TURN relay as last resort). Protocol and diagnostics ported
// verbatim from the Living Confluence ShareManager.
function b64url(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
function randomHex(n) {
  var b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}

var _peerjsLoading = null;
function ensurePeerJsLoaded() {
  if (window.Peer) return Promise.resolve();
  if (_peerjsLoading) return _peerjsLoading;
  _peerjsLoading = new Promise(function (res, rej) {
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
    s.crossOrigin = "anonymous";
    s.onload = function () { res(); };
    s.onerror = function () { rej(new Error("peerjs failed to load — network or CDN issue")); };
    document.head.appendChild(s);
  });
  return _peerjsLoading;
}

// Ephemeral TURN credentials from the configured minter; cached until ~1min
// before TTL. [] on any failure → PeerJS STUN-only defaults (degrade, don't break).
var _iceCache = null;
function getIceServers() {
  if (!SHARE_TURN_CREDENTIALS_URL) return Promise.resolve([]);
  if (_iceCache && Date.now() < _iceCache.expiresAt) return Promise.resolve(_iceCache.servers);
  return fetch(SHARE_TURN_CREDENTIALS_URL, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (data) {
      var servers = Array.isArray(data.iceServers) ? data.iceServers : [];
      var ttlMs = (Number(data.ttl) || 3600) * 1000;
      _iceCache = { servers: servers, expiresAt: Date.now() + Math.max(0, ttlMs - 60000) };
      console.log("[sinain-share] iceServers loaded: " + servers.length + " entries");
      return servers;
    })
    .catch(function (e) {
      console.warn("[sinain-share] TURN creds fetch failed: " + (e && e.message) + " — falling back to STUN-only");
      return [];
    });
}

function newPeer(idOrUndef, iceServers) {
  var opts = SHARE_PEERJS_HOST ? { host: SHARE_PEERJS_HOST, debug: 3 } : { debug: 3 };
  if (iceServers && iceServers.length) opts.config = { iceServers: iceServers };
  return idOrUndef ? new window.Peer(idOrUndef, opts) : new window.Peer(opts);
}
function instrumentPeer(peer, label) {
  var tag = "[sinain-share:" + label + "]";
  peer.on("open", function (id) { console.log(tag, "peer.open id=" + id); });
  peer.on("error", function (e) { console.warn(tag, "peer.error type=" + (e && e.type) + " msg=" + (e && e.message)); });
  peer.on("disconnected", function () { console.warn(tag, "peer.disconnected (lost broker connection)"); });
  peer.on("close", function () { console.log(tag, "peer.close (destroyed)"); });
}

var ShareManager = (function () {
  var peers = {}; // share_token → live Peer (sender side)

  function buildBundle(entityId) {
    return fetch("/knowledge/concepts/export?entity=" + encodeURIComponent(entityId) + "&depth=1&include_page=1")
      .then(function (r) { if (!r.ok) throw new Error("export failed: " + r.status); return r.text(); });
  }

  // Everything identifying rides in the URL fragment (never sent to the
  // redirector host): #e=<b64url entity>&p=<port>&peer=<token>.
  function buildShareUrl(entityId, token) {
    var port = location.port || (location.protocol === "https:" ? "443" : "80");
    return SHARE_BASE_URL + "#e=" + b64url(new TextEncoder().encode(entityId)) + "&p=" + port + "&peer=" + token;
  }

  function patchStatus(token, status, extra) {
    var body = Object.assign({ status: status }, extra || {});
    return fetchJson("/knowledge/shares/" + encodeURIComponent(token), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(refreshShareCount).catch(function () {});
  }

  function destroyPeer(token) {
    var peer = peers[token];
    if (peer) { try { peer.destroy(); } catch (e) {} delete peers[token]; }
  }

  function attachSenderHandlers(peer, token, entityId) {
    peer.on("connection", function (conn) {
      console.log("[sinain-share:sender:" + token.slice(0, 8) + "] inbound connection from", conn.peer);
      patchStatus(token, "connecting");
      conn.on("open", function () {
        buildBundle(entityId).then(function (bundle) {
          console.log("[sinain-share:sender:" + token.slice(0, 8) + "] sending bundle, " + bundle.length + " bytes");
          conn.send({ type: "bundle", payload: bundle });
        }).catch(function (e) {
          console.warn("[sinain-share:sender] buildBundle/send failed:", e);
          conn.send({ type: "error", message: String(e).slice(0, 200) });
          conn.close();
        });
      });
      conn.on("data", function (msg) {
        if (msg && msg.type === "ack") {
          patchStatus(token, "delivered", { delivered_at: Date.now() });
          setTimeout(function () { destroyPeer(token); }, 5000);
        }
      });
    });
    peer.on("disconnected", function () { patchStatus(token, "disconnected"); });
    peer.on("close", function () { patchStatus(token, "disconnected"); });
    peer.on("error", function (err) {
      console.warn("share peer error", token, err && err.type, err && err.message);
    });
  }

  function createShare(entityId) {
    return ensurePeerJsLoaded()
      .then(getIceServers)
      .then(function (ice) {
        var token = randomHex(8);
        var peer = newPeer(token, ice);
        instrumentPeer(peer, "sender:" + token.slice(0, 8));
        return new Promise(function (res, rej) {
          peer.on("open", function () { res({ peer: peer, token: token }); });
          peer.on("error", function (e) { rej(e); });
          setTimeout(function () { rej(new Error("peerjs broker timeout")); }, 8000);
        });
      })
      .then(function (ctx) {
        var url = buildShareUrl(entityId, ctx.token);
        return fetchJson("/knowledge/shares", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_id: entityId, mode: "peer", share_token: ctx.token, url: url }),
        }).then(function (r) {
          if (r.ok === false) throw new Error(r.error || "share registration failed");
          peers[ctx.token] = ctx.peer;
          attachSenderHandlers(ctx.peer, ctx.token, entityId);
          return navigator.clipboard.writeText(url).catch(function () {});
        }).then(function () {
          showToast("✓ Link copied · live until you revoke — keep this tab open to serve it");
          refreshShareCount();
        });
      })
      .catch(function (e) { showToast("Share failed: " + (e && e.message || e)); });
  }

  // Re-register sender peers for open shares when the UI loads, so links
  // created in an earlier session keep working while this tab is open.
  function resumePeerShares() {
    fetchJson("/knowledge/shares?status=waiting&status=connecting&status=disconnected").then(function (r) {
      var rows = (r && r.shares || []).filter(function (s) { return s.mode === "peer"; });
      if (!rows.length) return;
      ensurePeerJsLoaded().then(getIceServers).then(function (ice) {
        rows.forEach(function (share) {
          var peer = newPeer(share.share_token, ice);
          instrumentPeer(peer, "sender-resume:" + share.share_token.slice(0, 8));
          var opened = false;
          peer.on("open", function () {
            opened = true;
            peers[share.share_token] = peer;
            attachSenderHandlers(peer, share.share_token, share.entity_id);
            if (share.status !== "waiting") patchStatus(share.share_token, "waiting");
          });
          peer.on("error", function (e) {
            // "unavailable-id" = another tab already serves this share; leave it be.
            if (!opened) console.warn("resume failed for", share.share_token, e && e.type);
          });
        });
      }).catch(function () {});
    }).catch(function () {});
  }

  function revoke(token) {
    destroyPeer(token);
    return patchStatus(token, "revoked", { revoked_at: Date.now() });
  }
  function forget(token) {
    destroyPeer(token);
    return fetchJson("/knowledge/shares/" + encodeURIComponent(token), { method: "DELETE" })
      .then(refreshShareCount).catch(function () {});
  }

  function connectAsRecipient(token) {
    showToast("Connecting peer-to-peer…");
    return ensurePeerJsLoaded()
      .then(getIceServers)
      .then(function (ice) {
        var me = newPeer(undefined, ice);
        instrumentPeer(me, "recipient:" + token.slice(0, 8));
        return new Promise(function (res, rej) {
          me.on("open", function () { res(me); });
          me.on("error", function (e) { rej(e); });
          setTimeout(function () { rej(new Error("peerjs broker timeout")); }, 8000);
        });
      })
      .then(function (me) {
        return new Promise(function (resolve, reject) {
          var conn = me.connect(token, { reliable: true });
          var cleanup = function () { try { conn.close(); } catch (e) {} try { me.destroy(); } catch (e) {} };
          var openTimeout = setTimeout(function () {
            cleanup();
            reject(new Error("couldn't reach source over the network (NAT/relay) — try again"));
          }, 15000);
          me.on("error", function (e) {
            if (e && e.type === "peer-unavailable") {
              clearTimeout(openTimeout);
              cleanup();
              reject(new Error("source offline — the sender's Sinain isn't running"));
            }
          });
          conn.on("open", function () { clearTimeout(openTimeout); });
          conn.on("error", function (e) { cleanup(); reject(e); });
          conn.on("data", function (msg) {
            if (!msg) return;
            if (msg.type === "error") { cleanup(); reject(new Error("source error: " + msg.message)); return; }
            if (msg.type === "bundle") {
              fetchJson("/knowledge/concepts/import?conflict=merge", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: msg.payload,
              }).then(function (importR) {
                if (importR && importR.ok === false) { cleanup(); reject(new Error(importR.error || "import failed")); return; }
                conn.send({ type: "ack" });
                setTimeout(cleanup, 500);
                resolve(importR);
              }).catch(function (e) { cleanup(); reject(e); });
            }
          });
        });
      });
  }

  return { createShare: createShare, resumePeerShares: resumePeerShares, revoke: revoke, forget: forget, connectAsRecipient: connectAsRecipient };
})();

function createShare(entityId) { ShareManager.createShare(entityId); }

// ── rail ─────────────────────────────────────────────────────────────
var railCache = { at: 0, doc: null };
function loadRail() {
  var now = Date.now();
  if (railCache.doc && now - railCache.at < 30000) return Promise.resolve(railCache.doc);
  return fetchText("/knowledge/index.md").then(function (md) {
    railCache = { at: Date.now(), doc: parseMd(md) };
    return railCache.doc;
  });
}
function renderRail(doc) {
  var rail = $("#rail");
  rail.innerHTML = "";
  var r = state.route;
  var rootGroup = el("div", "railGroup");
  rootGroup.appendChild(el("div", "railHdr", "Vault"));
  [
    { label: "WIKI.md", kind: "wiki" },
    { label: "index.md", kind: "index" },
    { label: "log.md", kind: "log", also: "episode" },
    { label: "shares.md", kind: "shares", also: "share" },
    { label: "lint.md", kind: "lint" },
  ].forEach(function (n) {
    var active = r.kind === n.kind || r.kind === n.also;
    var node = el("div", "railNode root" + (active ? " active" : ""), n.label);
    node.onclick = function () { navigate({ kind: n.kind }); };
    rootGroup.appendChild(node);
  });
  rail.appendChild(rootGroup);

  var RAIL_VISIBLE = 10;
  (doc ? doc.sections : []).forEach(function (sec) {
    if (sec.heading === "Bookmarks") return;
    var m = sec.heading.match(/^(.*?)(?:\\s*\\((\\d+)\\))?$/);
    var group = el("div", "railGroup");
    group.appendChild(el("div", "railHdr", m ? m[1] : sec.heading));
    var nodes = [];
    sec.items.forEach(function (item) {
      if (item.type !== "bullet") return;
      var tk = tokenize(item.text).filter(function (t) { return t.link; })[0];
      if (!tk) return;
      var active = r.kind === "entity" && r.slug === tk.link;
      var node = el("div", "railNode" + (active ? " active" : ""), tk.t);
      node.onclick = function () { navigate({ kind: "entity", slug: tk.link }); };
      // Keep the active entity visible even when it sits past the fold.
      if (nodes.length >= RAIL_VISIBLE && !active) node.style.display = "none";
      nodes.push(node);
      group.appendChild(node);
    });
    if (nodes.length > RAIL_VISIBLE) {
      var hidden = nodes.length - RAIL_VISIBLE;
      var toggle = el("div", "railNode", "+ " + hidden + " more");
      toggle.style.color = "var(--muted)";
      var expanded = false;
      toggle.onclick = function () {
        expanded = !expanded;
        nodes.forEach(function (n, i) { if (i >= RAIL_VISIBLE) n.style.display = expanded ? "" : "none"; });
        toggle.textContent = expanded ? "− less" : "+ " + hidden + " more";
      };
      group.appendChild(toggle);
    }
    rail.appendChild(group);
  });

  var foot = el("div", "railFoot");
  var exp = el("button", "btn", "Export vault (.zip)");
  exp.style.width = "100%";
  exp.onclick = function () { location.href = "/knowledge/export?format=vault"; };
  foot.appendChild(exp);
  foot.appendChild(el("div", "hint", "Materializes every page once — Obsidian-openable. Scoped & redacted like a share."));
  rail.appendChild(foot);
}

// ── views ────────────────────────────────────────────────────────────
function renderChips(container, fm, order, linkKeys) {
  var chips = el("div", "chips");
  order.forEach(function (k) {
    var v = fm[k];
    if (v === undefined || v === "" || v === null) return;
    var text = Array.isArray(v) ? v.join(", ") : v;
    var chip = el("span", "chip");
    chip.appendChild(el("span", "k", k + " "));
    chip.appendChild(document.createTextNode(text));
    chips.appendChild(chip);
  });
  (linkKeys || []).forEach(function (spec) {
    var v = fm[spec.key];
    if (!v) return;
    (Array.isArray(v) ? v : [v]).forEach(function (id) {
      var chip = el("span", "chip link", id);
      chip.onclick = function () { navigate(spec.route(id)); };
      chips.appendChild(chip);
    });
  });
  if (chips.children.length) container.appendChild(chips);
}

function viewIndex(doc, main) {
  var page = el("div", "page wide");
  page.appendChild(el("div", "pTitle small", doc.title || "Index"));
  page.appendChild(el("div", "pSub", "The catalog is a query — always current by construction. Nothing to regenerate, nothing to rot."));
  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    if (sec.heading === "Bookmarks") {
      var hdr = el("div", "grpHdr");
      hdr.appendChild(el("span", "l", "Bookmarks"));
      wrap.appendChild(hdr);
      var chips = el("div", "fchips");
      sec.items.forEach(function (item) {
        var tk = tokenize(item.text).filter(function (t) { return t.link; })[0];
        if (!tk) return;
        var c = el("div", "fchip", tk.t);
        c.onclick = function () { navigate(linkRoute(tk.link)); };
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    } else {
      var m = sec.heading.match(/^(.*?)(?:\\s*\\((\\d+)\\))?$/);
      var hdr2 = el("div", "grpHdr");
      hdr2.appendChild(el("span", "l", m ? m[1] : sec.heading));
      if (m && m[2]) hdr2.appendChild(el("span", "c", m[2] + " pages"));
      wrap.appendChild(hdr2);
      var CARDS_VISIBLE = 12;
      var grid = el("div", "cards");
      var cards = [];
      sec.items.forEach(function (item) {
        if (item.type !== "bullet") return;
        var parts = item.text.split(" — ");
        var tk = tokenize(parts[0]).filter(function (t) { return t.link; })[0];
        if (!tk) return;
        var card = el("div", "card");
        card.appendChild(el("div", "t", tk.t));
        if (parts[1]) card.appendChild(el("div", "m", parts[1]));
        card.onclick = function () { navigate(linkRoute(tk.link)); };
        if (cards.length >= CARDS_VISIBLE) card.style.display = "none";
        cards.push(card);
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      if (cards.length > CARDS_VISIBLE) {
        var more = el("button", "btn", "Show all " + cards.length);
        more.style.marginTop = "10px";
        var open = false;
        more.onclick = function () {
          open = !open;
          cards.forEach(function (c, i) { if (i >= CARDS_VISIBLE) c.style.display = open ? "" : "none"; });
          more.textContent = open ? "Show fewer" : "Show all " + cards.length;
        };
        wrap.appendChild(more);
      }
    }
    page.appendChild(wrap);
  });

  var drop = el("div", "drop",
    "Drop a concept bundle (.json) to import — markdown & vault .zip escrow lands with P3. Re-import dedups, never duplicates.");
  var picker = el("input");
  picker.type = "file"; picker.style.display = "none";
  picker.onchange = function () { if (picker.files[0]) importFile(picker.files[0]); };
  drop.onclick = function () { picker.click(); };
  drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = function () { drop.classList.remove("over"); };
  drop.ondrop = function (e) {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  };
  page.appendChild(drop);
  page.appendChild(picker);
  main.appendChild(page);
}

function importFile(file) {
  if (!/\\.json$/i.test(file.name)) {
    showToast("Only concept bundles (.json) import today — markdown/vault import lands with P3.");
    return;
  }
  file.text().then(function (text) {
    return fetchJson("/knowledge/concepts/import?conflict=merge", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: text,
    });
  }).then(function (r) {
    if (r.ok === false) { showToast("Import failed: " + (r.error || "unknown")); return; }
    railCache.at = 0;
    showToast("✓ Imported — " + (r.triples_applied || r.triples || "bundle") + " applied. Re-import dedups by slug.");
  }).catch(function (e) { showToast("Import failed: " + e); });
}

function viewEntity(doc, main, slug) {
  var page = el("div", "page");
  var entityId = doc.fm.id || ("entity:" + slug);
  renderChips(page, doc.fm, ["id", "type", "domain", "confidence", "facts", "tx", "aliases"],
    [{ key: "sources", route: function (id) { return { kind: "episode", id: id }; } }]);

  var titleRow = el("div", "titleRow");
  titleRow.appendChild(el("div", "pTitle", doc.title || slug));
  var btns = el("div", "titleBtns");
  var shareBtn = el("button", "btn", "Share");
  shareBtn.onclick = function () { createShare(entityId); };
  var refreshBtn = el("button", "btn", "↻");
  refreshBtn.title = "Re-render from live facts";
  refreshBtn.onclick = function () { render(true); };
  btns.appendChild(shareBtn); btns.appendChild(refreshBtn);
  titleRow.appendChild(btns);
  page.appendChild(titleRow);
  page.appendChild(el("div", "", "\\u00A0"));

  doc.intro.forEach(function (item) {
    if (item.type === "para") {
      var s = el("div", "summary");
      renderTokens(s, item.text);
      page.appendChild(s);
    }
  });

  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) {
      if (item.type !== "bullet") { appendGeneric(wrap, item); return; }
      if (item.pred) {
        var edge = el("div", "edgeRow");
        edge.appendChild(el("span", "pred", item.pred + "::"));
        var lt = el("span");
        renderTokens(lt, "[[" + item.text.replace(/^\\[\\[|\\]\\]$/g, "") + "]]");
        edge.appendChild(lt);
        wrap.appendChild(edge);
        return;
      }
      if (item.anchor) {
        var row = el("div", "factRow");
        var txt = el("div", "txt");
        renderTokens(txt, item.text);
        row.appendChild(txt);
        if (item.conf) row.appendChild(el("span", "conf", item.conf));
        row.appendChild(el("span", "anchor", "^" + item.anchor));
        var act = el("span", "act", "retract");
        row.appendChild(act);
        wrap.appendChild(row);
        styleFactRow(row, item.anchor, entityId);
        return;
      }
      var b = el("div", "bulletRow");
      var bt = el("span");
      renderTokens(bt, item.text);
      b.appendChild(bt);
      wrap.appendChild(b);
    });
    page.appendChild(wrap);
  });
  main.appendChild(page);
}

function viewLog(doc, main) {
  var page = el("div", "page");
  page.appendChild(el("div", "pTitle small", "Log"));
  page.appendChild(el("div", "pSub", "The append-only record, virtually paginated — every entry links to its episode page."));
  var kindColors = { ingest: "var(--accent)", breakpoint: "var(--amber)", "import": "var(--purple)", lint: "var(--teal)", "return": "var(--secondary)", session: "var(--secondary)", segment: "var(--accent)" };
  var any = false;
  doc.sections.concat([{ items: doc.intro }]).forEach(function (sec) {
    sec.items.forEach(function (item) {
      if (item.type === "foot") { page.appendChild(el("div", "foot", item.text)); return; }
      if (item.type !== "bullet" || !item.ts) return;
      any = true;
      var tk = tokenize(item.text).filter(function (t) { return t.link; })[0];
      var row = el("div", "logRow");
      row.appendChild(el("span", "ts", item.ts));
      var k = el("span", "kind", item.kind || "");
      k.style.color = kindColors[item.kind] || "var(--secondary)";
      row.appendChild(k);
      var rest = item.text.replace(/\\[\\[[^\\]]+\\]\\]\\s*/, "");
      row.appendChild(el("span", "sum", rest));
      if (tk) row.appendChild(el("span", "eid", tk.link.replace("episode/", "")));
      if (tk) row.onclick = function () { navigate(linkRoute(tk.link)); };
      page.appendChild(row);
    });
  });
  if (!any) page.appendChild(el("div", "empty", "No episodes yet — memoryd has recorded nothing in this window."));
  main.appendChild(page);
}

function viewEpisode(doc, main) {
  var page = el("div", "page");
  renderChips(page, doc.fm, ["kind", "t_start", "t_end", "source", "context"], []);
  var t = el("div", "pTitle mono", doc.title || doc.fm.id || "");
  page.appendChild(t);
  page.appendChild(el("div", "pSub", "T1 escrow — immutable. Whatever extraction missed, this text stays retrievable."));
  doc.intro.forEach(function (item) {
    if (item.type === "quote") {
      var q = el("div", "quote");
      renderTokens(q, item.text);
      page.appendChild(q);
    }
  });
  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) { appendGeneric(wrap, item); });
    page.appendChild(wrap);
  });
  main.appendChild(page);
}

function viewTopic(doc, main, q) {
  var page = el("div", "page");
  var row = el("div", "titleRow");
  row.appendChild(el("div", "pTitle small", doc.title || ("topic: " + q)));
  if (doc.fm.tx) row.appendChild(el("span", "chip mono", "cached @ tx " + doc.fm.tx));
  page.appendChild(row);
  page.appendChild(el("div", "pSub", "A topic page just is the query — filed back as a page."));
  var answer = el("div", "quote answer");
  var hasQuote = false;
  doc.intro.forEach(function (item) {
    if (item.type === "quote") {
      hasQuote = true;
      renderTokens(answer, item.text);
      answer.appendChild(document.createTextNode(" "));
    }
  });
  if (hasQuote) page.appendChild(answer);
  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) {
      if (item.type !== "bullet") { appendGeneric(wrap, item); return; }
      var parts = item.text.split(" — ");
      var tk = tokenize(parts[0]).filter(function (t) { return t.link; })[0];
      if (!tk) { appendGeneric(wrap, item); return; }
      var r = el("div", "logRow");
      var box = el("div");
      box.appendChild(el("div", "t wl", tk.t));
      if (parts[1]) box.appendChild(el("div", "m", parts[1]));
      box.style.minWidth = "0";
      r.appendChild(box);
      r.onclick = function () { navigate(linkRoute(tk.link)); };
      wrap.appendChild(r);
    });
    page.appendChild(wrap);
  });
  main.appendChild(page);
}

// Lint view: findings grouped by verdict, each row with its ^f-id anchor so
// individual retract/restore reuses the entity-page machinery; one apply
// button bulk-retracts the default verdicts (two-click confirm, no dialogs).
function viewLint(doc, main) {
  var page = el("div", "page");
  page.appendChild(el("div", "pTitle small", "Lint"));
  page.appendChild(el("div", "pSub", "What should never have been a fact. Retraction is bi-temporal and restorable; the transcript escrow keeps all source text regardless."));

  var stats = el("div", "chips");
  Object.keys(doc.fm).forEach(function (k) {
    if (k === "id" || k === "title") return;
    var chip = el("span", "chip");
    chip.appendChild(el("strong", "", String(doc.fm[k]) + " "));
    chip.appendChild(document.createTextNode(k));
    stats.appendChild(chip);
  });
  page.appendChild(stats);

  var applyTotal = 0;
  doc.sections.forEach(function (sec) {
    var m = sec.heading.match(/^(\\w+)\\s*\\((\\d+)\\)/);
    if (m && m[1] !== "unattributed") applyTotal += parseInt(m[2]);
  });

  if (applyTotal > 0) {
    var applyBtn = el("button", "btn", "Apply lint — retract " + applyTotal + " facts");
    applyBtn.style.margin = "14px 0";
    var armed = false;
    applyBtn.onclick = function () {
      if (!armed) {
        armed = true;
        applyBtn.textContent = "Confirm: retract " + applyTotal + " facts (restorable)";
        applyBtn.style.color = "var(--red)";
        setTimeout(function () {
          armed = false;
          applyBtn.textContent = "Apply lint — retract " + applyTotal + " facts";
          applyBtn.style.color = "";
        }, 6000);
        return;
      }
      applyBtn.disabled = true;
      applyBtn.textContent = "Applying…";
      fetchJson("/knowledge/lint/apply", { method: "POST" }).then(function (r) {
        if (!r.ok) { showToast("Lint apply failed: " + (r.error || "unknown")); applyBtn.disabled = false; return; }
        railCache.at = 0;
        showToast("✓ Lint applied — " + r.applied + " facts retracted (bi-temporal, restorable)");
        render();
      }).catch(function (e) { showToast("Lint apply failed: " + e); applyBtn.disabled = false; });
    };
    page.appendChild(applyBtn);
  }

  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) {
      if (item.type !== "bullet" || !item.anchor) { appendGeneric(wrap, item); return; }
      var firstLink = tokenize(item.text).filter(function (t) { return t.link; })[0];
      var sourceEntity = firstLink ? "entity:" + firstLink.link : null;
      var row = el("div", "factRow");
      var txt = el("div", "txt");
      renderTokens(txt, item.text);
      row.appendChild(txt);
      if (item.conf) row.appendChild(el("span", "conf", item.conf));
      row.appendChild(el("span", "anchor", "^" + item.anchor));
      var act = el("span", "act", "retract");
      row.appendChild(act);
      wrap.appendChild(row);
      styleFactRow(row, item.anchor, sourceEntity);
    });
    page.appendChild(wrap);
  });
  main.appendChild(page);
}

function viewShares(doc, main) {
  var page = el("div", "page");
  page.appendChild(el("div", "pTitle small", "Shares"));
  page.appendChild(el("div", "pSub", "A share is a scoped slice of the address space. The recipient's link preview is a wiki page."));
  var any = false;
  doc.sections.concat([{ items: doc.intro }]).forEach(function (sec) {
    sec.items.forEach(function (item) {
      if (item.type !== "bullet") return;
      var links = tokenize(item.text).filter(function (t) { return t.link; });
      var shareLink = links.filter(function (t) { return t.link.indexOf("share/") === 0; })[0];
      if (!shareLink) return;
      any = true;
      var status = (item.text.match(/\\*\\*(\\w+)\\*\\*/) || [])[1] || "";
      var entLink = links.filter(function (t) { return t.link.indexOf("share/") !== 0; })[0];
      var meta = item.text.split(" — ")[1] || "";
      var row = el("div", "shareRow");
      var box = el("div");
      box.appendChild(el("div", "t", entLink ? entLink.t : shareLink.t));
      box.appendChild(el("div", "m", meta));
      row.appendChild(box);
      row.appendChild(el("span", "pill " + status, status));
      row.onclick = function () { navigate(linkRoute(shareLink.link)); };
      page.appendChild(row);
    });
  });
  if (!any) page.appendChild(el("div", "empty", "No shares yet — create one from any entity page."));
  main.appendChild(page);
}

function viewShare(doc, main) {
  var page = el("div", "page");
  var row = el("div", "titleRow");
  row.appendChild(el("div", "pTitle small", doc.title || "Share"));
  if (doc.fm.status) row.appendChild(el("span", "pill " + doc.fm.status, doc.fm.status));
  page.appendChild(row);
  var metaBits = [];
  if (doc.fm.mode) metaBits.push(doc.fm.mode);
  if (doc.fm.created) metaBits.push("created " + String(doc.fm.created).slice(0, 10));
  if (doc.fm.bundle_size) metaBits.push(doc.fm.bundle_size + " B");
  page.appendChild(el("div", "pSub", metaBits.join(" · ")));
  var link = "";
  doc.sections.forEach(function (sec) {
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) { appendGeneric(wrap, item); });
    page.appendChild(wrap);
  });
  doc.intro.forEach(function (item) {
    if (item.type === "para" && item.text.indexOf("Link: ") === 0) link = item.text.slice(6);
    else if (item.type === "para" && item.text.indexOf("Redaction") === 0) page.appendChild(el("div", "redaction", item.text));
  });
  if (link) {
    var box = el("div", "linkBox", link);
    box.title = "Click to copy";
    box.style.cursor = "pointer";
    box.onclick = function () {
      navigator.clipboard.writeText(link).then(function () { showToast("✓ Link copied"); });
    };
    page.appendChild(box);
  }
  var actions = el("div", "");
  actions.style.marginTop = "16px";
  actions.style.display = "flex";
  actions.style.gap = "8px";
  var revoke = el("button", "btn", "Revoke");
  revoke.onclick = function () {
    ShareManager.revoke(state.route.token).then(function () {
      showToast("Share revoked — the peer no longer answers");
      navigate({ kind: "shares" });
    });
  };
  var forget = el("button", "btn", "Forget");
  forget.title = "Remove this share record entirely";
  forget.onclick = function () {
    ShareManager.forget(state.route.token).then(function () {
      showToast("Share forgotten");
      navigate({ kind: "shares" });
    });
  };
  actions.appendChild(revoke);
  actions.appendChild(forget);
  page.appendChild(actions);
  main.appendChild(page);
}

function viewWiki(doc, main) {
  var page = el("div", "page");
  page.appendChild(el("div", "pTitle small", "WIKI.md"));
  page.appendChild(el("div", "pSub", "The schema layer. Also served at sinain://AGENTS.md — agent frameworks find it unprompted. First thing any connecting LLM reads."));
  var stats = el("div", "chips");
  ["entities", "facts", "episodes", "last_ingest"].forEach(function (k) {
    if (doc.fm[k] === undefined) return;
    var chip = el("span", "chip");
    chip.appendChild(el("strong", "", String(doc.fm[k]) + " "));
    chip.appendChild(document.createTextNode(k.replace("_", " ")));
    stats.appendChild(chip);
  });
  page.appendChild(stats);
  doc.intro.forEach(function (item) { appendGeneric(page, item); });
  doc.sections.forEach(function (sec) {
    if (sec.heading === "Stats") return; // chips above
    var wrap = el("div", "secWrap");
    wrap.appendChild(el("div", "secHdr", sec.heading));
    sec.items.forEach(function (item) { appendGeneric(wrap, item); });
    page.appendChild(wrap);
  });
  main.appendChild(page);
}

function appendGeneric(container, item) {
  if (item.type === "bullet") {
    var b = el("div", "mdBullet");
    b.appendChild(document.createTextNode("· "));
    renderTokens(b, item.text + (item.conf ? " · conf " + item.conf : "") + (item.anchor ? " ^" + item.anchor : ""));
    container.appendChild(b);
  } else if (item.type === "quote") {
    var q = el("div", "quote");
    renderTokens(q, item.text);
    container.appendChild(q);
  } else if (item.type === "foot") {
    container.appendChild(el("div", "foot", item.text));
  } else {
    var p = el("p", "mdP");
    renderTokens(p, item.text);
    container.appendChild(p);
  }
}

// ── render loop ──────────────────────────────────────────────────────
var renderSeq = 0;
function render(refresh) {
  var seq = ++renderSeq;
  var route = state.route;
  var addr = mdPath(route);
  $("#addrId").textContent = "sinain://" + decodeURIComponent(addr);
  $("#addrHttp").textContent = "GET localhost:" + (location.port || "80") + "/knowledge/" + addr;

  var main = $("#main");
  main.innerHTML = "<div class='page'><div class='empty'>Rendering " + decodeURIComponent(addr) + "…</div></div>";

  var qs = route.kind === "entity" ? "?ui=1" + (refresh ? "&refresh=1" : "") : "";
  var mdPromise = fetchText("/knowledge/" + addr + qs);
  var railPromise = loadRail();

  Promise.all([mdPromise, railPromise]).then(function (rs) {
    if (seq !== renderSeq) return; // stale render
    var doc = parseMd(rs[0]);
    renderRail(rs[1]);
    main.innerHTML = "";
    state.retracted = {}; state.undoTokens = {};
    if (route.kind === "index") viewIndex(doc, main);
    else if (route.kind === "entity") viewEntity(doc, main, route.slug);
    else if (route.kind === "wiki") viewWiki(doc, main);
    else if (route.kind === "log") viewLog(doc, main);
    else if (route.kind === "episode") viewEpisode(doc, main);
    else if (route.kind === "topic") viewTopic(doc, main, route.q);
    else if (route.kind === "shares") viewShares(doc, main);
    else if (route.kind === "lint") viewLint(doc, main);
    else if (route.kind === "share") viewShare(doc, main);
  }).catch(function (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = "";
    var pg = el("div", "page");
    pg.appendChild(el("div", "empty", "Failed to render " + addr + ": " + e));
    main.appendChild(pg);
  });
}

// ── search ───────────────────────────────────────────────────────────
var searchTimer = null;
$("#q").addEventListener("input", function () {
  var q = this.value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (!q) { $("#drop").style.display = "none"; return; }
  searchTimer = setTimeout(function () { runSearch(q); }, 200);
});
$("#q").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && this.value.trim()) {
    $("#drop").style.display = "none";
    navigate({ kind: "topic", q: this.value.trim() });
  }
  if (e.key === "Escape") { $("#drop").style.display = "none"; }
});
document.addEventListener("click", function (e) {
  if (!e.target.closest(".searchWrap")) $("#drop").style.display = "none";
});
function runSearch(q) {
  fetchJson("/knowledge/search?q=" + encodeURIComponent(q) + "&limit=6").then(function (r) {
    var drop = $("#drop");
    drop.innerHTML = "";
    (r.results || []).forEach(function (res) {
      var slug = res.entity.indexOf("entity:") === 0 ? res.entity.slice(7) : res.entity.replace(":", "__");
      var row = el("div", "searchRow");
      var line = el("div");
      line.appendChild(el("span", "t", res.name || slug));
      if (res.type || res.domain) line.appendChild(el("span", "badge", res.domain || res.type));
      row.appendChild(line);
      row.appendChild(el("div", "m", (res.fact_count || 0) + " facts · entity/" + slug + ".md"));
      row.onclick = function () { drop.style.display = "none"; $("#q").value = ""; navigate({ kind: "entity", slug: slug }); };
      drop.appendChild(row);
    });
    var ask = el("div", "searchRow");
    var askLine = el("div", "m");
    askLine.appendChild(document.createTextNode("Ask as topic page → "));
    askLine.appendChild(el("span", "mono", "topic/" + q + ".md"));
    ask.appendChild(askLine);
    ask.onclick = function () { drop.style.display = "none"; navigate({ kind: "topic", q: q }); };
    drop.appendChild(ask);
    drop.style.display = "block";
  }).catch(function () {});
}

// ── chrome wiring ────────────────────────────────────────────────────
$("#logo").onclick = function () { navigate({ kind: "index" }); };
$("#sharesBtn").onclick = function () { navigate({ kind: "shares" }); };
function refreshShareCount() {
  // Live shares only — a delivered share needs no attention.
  fetchJson("/knowledge/shares?status=waiting&status=connecting").then(function (r) {
    var n = (r.shares || []).length;
    $("#shareCount").textContent = n ? String(n) : "";
  }).catch(function () {});
}
// ── incoming share links ─────────────────────────────────────────────
// share.html redirects here with everything in the fragment:
// #e=<b64url entity>&p=<port>&peer=<token> (live peer transfer — the
// canonical form) | &bundle=<gzip b64url> (legacy inline links, still
// accepted on receive).
function b64urlDecode(s) {
  var b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return bytes;
}
function afterShareImport(entB64) {
  railCache.at = 0;
  var entityId = "";
  try { entityId = new TextDecoder().decode(b64urlDecode(entB64 || "")); } catch (e) {}
  showToast("✓ Shared concept imported");
  if (entityId) {
    var slug = entityId.indexOf("entity:") === 0 ? entityId.slice(7) : entityId.replace(":", "__");
    navigate({ kind: "entity", slug: slug });
  } else render();
}
function handleIncomingShare() {
  if (!location.hash || location.hash.length < 2) return false;
  var params = new URLSearchParams(location.hash.slice(1));
  var bundle = params.get("bundle");
  var peer = params.get("peer");
  var entB64 = params.get("e");
  if (!peer && !bundle) return false;
  history.replaceState({}, "", location.pathname);
  if (peer) {
    ShareManager.connectAsRecipient(peer)
      .then(function () { afterShareImport(entB64); })
      .catch(function (e) { showToast("Share import failed: " + (e && e.message || e)); });
    return true;
  }
  showToast("Importing shared concept…");
  var gunzip = new Blob([b64urlDecode(bundle)]).stream().pipeThrough(new DecompressionStream("gzip"));
  new Response(gunzip).text().then(function (text) {
    return fetchJson("/knowledge/concepts/import?conflict=merge", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: text,
    });
  }).then(function (r) {
    if (r.ok === false) { showToast("Share import failed: " + (r.error || "unknown")); return; }
    afterShareImport(entB64);
  }).catch(function (e) { showToast("Share import failed: " + e); });
  return true;
}

refreshShareCount();
render();
// Incoming link → receive it; otherwise re-arm sender peers for any open
// shares so links created in earlier sessions answer while this tab lives.
if (!handleIncomingShare()) ShareManager.resumePeerShares();
</script>
</body>
</html>`;

/** Inject share config at serve time (env-driven, like the previous SPA).
 *
 *  - SINAIN_SHARE_BASE_URL: public share-redirector (sinain.com carries the
 *    current docs/share.html; fragments never reach the host).
 *  - SINAIN_PEERJS_HOST: peerjs broker override; empty = peerjs.com cloud.
 *  - SINAIN_TURN_CREDENTIALS_URL: ephemeral TURN credential minter for the
 *    WebRTC relay path; empty = STUN-only. */
export function renderWikiUi(): string {
  const shareBaseUrl = process.env.SINAIN_SHARE_BASE_URL || "https://sinain.com/share.html";
  const peerHost = process.env.SINAIN_PEERJS_HOST || "";
  const turnCredsUrl = process.env.SINAIN_TURN_CREDENTIALS_URL
    || "https://turn.sinain.com/turn-credentials";
  return KNOWLEDGE_WIKI_UI_HTML
    .replace(/__WIKI_SHARE_BASE_URL__/g, JSON.stringify(shareBaseUrl))
    .replace(/__WIKI_SHARE_PEERJS_HOST__/g, JSON.stringify(peerHost))
    .replace(/__WIKI_SHARE_TURN_CREDENTIALS_URL__/g, JSON.stringify(turnCredsUrl));
}
