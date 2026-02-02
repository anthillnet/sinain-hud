import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Load .env (project root) — does NOT override existing env vars ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');
try {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
  console.log(`[env] loaded ${envPath}`);
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`[env] failed to read ${envPath}:`, err.message);
}

// ── Server epoch — lets clients detect relay restarts ──
const serverEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ── Feed ring buffer (existing) ──
const messages = [];
let nextId = 1;
let feedVersion = 0; // increments on every POST /feed and agent push

// ── Sense event ring buffer (screen capture pipeline) ──
const senseBuffer = [];
let senseNextId = 1;
let senseVersion = 0; // increments on every POST /sense
const MAX_SENSE_EVENTS = 30;
const MAX_SENSE_BODY = 2 * 1024 * 1024; // 2MB

// ── Agent analysis loop ──
const agentBuffer = [];
const MAX_AGENT_RESULTS = 50;
let agentNextId = 1;
let agentTimer = null;
let lastPushedHud = '';
let lastTickFeedVersion = 0;
let lastTickSenseVersion = 0;
let latestDigest = null;

const agentStats = {
  totalCalls: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  lastAnalysisTs: 0,
  idleSkips: 0,
  parseSuccesses: 0,
  parseFailures: 0,
  consecutiveIdenticalHud: 0,
  hudChanges: 0,
};

const agentConfig = {
  enabled: env('AGENT_ENABLED', 'false') === 'true',
  intervalMs: intEnv('AGENT_INTERVAL_MS', 30000),
  model: env('AGENT_MODEL', 'google/gemini-2.5-flash-lite'),
  openrouterApiKey: env('OPENROUTER_API_KEY', ''),
  maxAgeMs: intEnv('AGENT_MAX_AGE_MS', 120000),
  maxTokens: intEnv('AGENT_MAX_TOKENS', 300),
  temperature: parseFloat(env('AGENT_TEMPERATURE', '0.3')),
  pushToFeed: env('AGENT_PUSH_TO_FEED', 'true') === 'true',
  logVerbose: env('AGENT_LOG_VERBOSE', 'false') === 'true',
  debounceMs: intEnv('AGENT_DEBOUNCE_MS', 3000),
  maxIntervalMs: intEnv('AGENT_MAX_INTERVAL_MS', 30000),
  fallbackModels: env('AGENT_FALLBACK_MODELS', 'google/gemini-2.5-flash,anthropic/claude-3.5-haiku').split(',').map(s => s.trim()).filter(Boolean),
};

let agentDebounceTimer = null;
let agentMaxIntervalTimer = null;

// ── SITUATION.md + OpenClaw escalation ──

const situationConfig = {
  enabled: env('SITUATION_MD_ENABLED', 'true') === 'true',
  workspaceDir: env('OPENCLAW_WORKSPACE_DIR', '').replace(/^~/, os.homedir())
                || path.join(os.homedir(), '.openclaw', 'workspace'),
};

const openclawConfig = {
  gatewayWsUrl: env('OPENCLAW_GATEWAY_WS_URL', 'ws://localhost:18789'),
  gatewayToken: env('OPENCLAW_GATEWAY_TOKEN', ''),  // WS auth (gateway.auth.token)
  hookUrl: env('OPENCLAW_HOOK_URL', 'http://localhost:18789/hooks/agent'),
  hookToken: env('OPENCLAW_HOOK_TOKEN', ''),         // HTTP hooks auth (hooks.token)
  sessionKey: env('OPENCLAW_SESSION_KEY', 'agent:main:main'), // agent session to escalate to
  escalationMode: env('ESCALATION_MODE', 'selective'), // 'focus' | 'selective' | 'off'
  escalationCooldownMs: intEnv('ESCALATION_COOLDOWN_MS', 30000),
};

const escalationStats = {
  totalEscalations: 0,
  totalResponses: 0,
  totalErrors: 0,
  totalNoReply: 0,
  lastEscalationTs: 0,
  lastResponseTs: 0,
};

let openclawWs = null;
let openclawRpcId = 1;
const openclawPending = new Map();
let openclawReconnectTimer = null;
let lastEscalatedDigest = '';
let firstEscalationStructureDumped = false;

function env(key, fallback) {
  return process.env[key] || fallback;
}
function intEnv(key, fallback) {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

// ── Helpers ──

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', c => {
      bytes += c.length;
      if (bytes > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function stripImageData(event) {
  const stripped = { ...event };
  if (stripped.roi) {
    stripped.roi = { ...stripped.roi };
    delete stripped.roi.data;
  }
  if (stripped.diff) {
    stripped.diff = { ...stripped.diff };
    delete stripped.diff.data;
  }
  return stripped;
}

// ── App name normalization ──

const APP_NAMES = {
  'idea': 'IntelliJ IDEA',
  'code': 'VS Code',
  'code - insiders': 'VS Code Insiders',
  'webstorm': 'WebStorm',
  'pycharm': 'PyCharm',
  'datagrip': 'DataGrip',
  'google chrome': 'Chrome',
  'firefox': 'Firefox',
  'safari': 'Safari',
  'telegram lite': 'Telegram',
  'telegram': 'Telegram',
  'iterm2': 'iTerm',
  'terminal': 'Terminal',
  'finder': 'Finder',
  'audio midi setup': 'Audio MIDI Setup',
};

function normalizeAppName(app) {
  return APP_NAMES[app.toLowerCase()] || app;
}

// ── Context Window ──

function buildContextWindow(maxAgeMs) {
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  // Extract transcript text from feed items
  const audioEvents = messages
    .filter(m => m.ts >= cutoff)
    .filter(m => m.text.includes('[PERIODIC]') || m.text.includes('openrouter]'))
    .map(m => {
      const lines = m.text.split('\n')
        .filter(l => l.includes('openrouter]'))
        .map(l => l.replace(/^\[.*?openrouter\]\s*/, '').trim())
        .filter(Boolean);
      return { ts: m.ts, text: lines.join(' ') };
    })
    .filter(e => e.text.length > 0);

  // Extract sense events (screen)
  const screenEvents = senseBuffer
    .filter(e => e.receivedAt >= cutoff)
    .map(e => ({
      ts: e.ts,
      type: e.type,
      app: e.meta?.app || 'unknown',
      ocr: e.ocr || '',
      ssim: e.meta?.ssim,
    }));

  // Determine current app
  const latestSense = screenEvents[screenEvents.length - 1];
  const currentApp = latestSense?.app || 'unknown';

  // Deduplicate OCR text
  const dedupedScreen = [];
  let lastOcr = '';
  for (const e of screenEvents) {
    if (e.ocr && e.ocr !== lastOcr) {
      dedupedScreen.push(e);
      lastOcr = e.ocr;
    } else if (!e.ocr && e.type === 'context') {
      dedupedScreen.push(e);
    }
  }

  // Track app switch timeline
  const appHistory = [];
  let lastApp = '';
  for (const e of screenEvents) {
    if (e.app !== lastApp) {
      appHistory.push({ app: e.app, ts: e.ts });
      lastApp = e.app;
    }
  }

  // Sort newest-first for recency weighting
  const sortedAudio = audioEvents.slice(-5).reverse();
  const sortedScreen = dedupedScreen.slice(-15).reverse();

  return {
    currentApp,
    appHistory,
    audio: sortedAudio,
    screen: sortedScreen,
    audioCount: audioEvents.length,
    screenCount: screenEvents.length,
    windowMs: maxAgeMs,
    newestEventTs: Math.max(
      sortedAudio[0]?.ts || 0,
      sortedScreen[0]?.ts || 0
    ),
  };
}

// ── LLM Prompt ──

function buildPrompt(ctx) {
  const now = Date.now();
  const screenLines = ctx.screen
    .map(e => {
      const app = normalizeAppName(e.app);
      const ago = Math.round((now - (e.ts || now)) / 1000);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, ' ').slice(0, 200) : '(no text)';
      return `[${ago}s ago] [${app}] ${ocr}`;
    })
    .join('\n');

  const audioLines = ctx.audio
    .map(e => {
      const ago = Math.round((now - (e.ts || now)) / 1000);
      return `[${ago}s ago] ${e.text.slice(0, 300)}`;
    })
    .join('\n');

  const appSwitches = ctx.appHistory
    .map(a => normalizeAppName(a.app))
    .join(' → ');

  return `You are an AI monitoring a user's screen and audio in real-time.
You produce TWO outputs as JSON.

Active app: ${normalizeAppName(ctx.currentApp)}
App history: ${appSwitches || '(none)'}

Screen (OCR text, newest first):
${screenLines || '(no screen data)'}

Audio transcript (newest first):
${audioLines || '(silence)'}

Respond ONLY with valid JSON. No markdown, no code fences, no explanation.
Your entire response must be parseable by JSON.parse().

{"hud":"<max 15 words: what user is doing NOW>","digest":"<3-5 sentences: detailed activity description>"}

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.
- CRITICAL: Output ONLY the JSON object, nothing else.`;
}

// ── SITUATION.md Writer ──

function writeSituationMd(contextWindow, digest, entry) {
  if (!situationConfig.enabled) return;

  const dir = situationConfig.workspaceDir;
  const filePath = path.join(dir, 'SITUATION.md');
  const tmpPath = filePath + '.tmp';

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.error('[situation] mkdir failed:', err.message);
      return;
    }
  }

  const now = new Date();
  const lines = [];

  lines.push('# Situation');
  lines.push('');
  lines.push(`> Auto-updated by sinain-hud relay at ${now.toISOString()}`);
  lines.push(`> Tick #${entry.id} | Latency: ${entry.latencyMs}ms | Model: ${entry.model}`);
  lines.push('');

  lines.push('## Digest');
  lines.push('');
  lines.push(digest);
  lines.push('');

  const currentApp = normalizeAppName(contextWindow.currentApp);
  lines.push('## Active Application');
  lines.push('');
  lines.push(currentApp);
  lines.push('');

  if (contextWindow.appHistory.length > 0) {
    lines.push('## App History');
    lines.push('');
    const appChain = contextWindow.appHistory
      .map(a => normalizeAppName(a.app))
      .join(' -> ');
    lines.push(appChain);
    lines.push('');
  }

  if (contextWindow.screen.length > 0) {
    lines.push('## Screen (OCR)');
    lines.push('');
    for (const e of contextWindow.screen) {
      const app = normalizeAppName(e.app);
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, ' ').slice(0, 500) : '(no text)';
      lines.push(`- [${ago}s ago] [${app}] ${ocr}`);
    }
    lines.push('');
  }

  if (contextWindow.audio.length > 0) {
    lines.push('## Audio Transcripts');
    lines.push('');
    for (const e of contextWindow.audio) {
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      lines.push(`- [${ago}s ago] ${e.text.slice(0, 500)}`);
    }
    lines.push('');
  }

  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Screen events in window: ${contextWindow.screenCount}`);
  lines.push(`- Audio events in window: ${contextWindow.audioCount}`);
  lines.push(`- Context window: ${Math.round(contextWindow.windowMs / 1000)}s`);
  lines.push(`- Parsed OK: ${entry.parsedOk}`);
  lines.push('');

  const content = lines.join('\n');

  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    if (agentConfig.logVerbose) {
      console.log(`[situation] wrote ${content.length} chars to ${filePath}`);
    }
  } catch (err) {
    console.error('[situation] write failed:', err.message);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── OpenClaw Gateway WebSocket Client ──

let openclawAuthenticated = false;

function connectOpenClawGateway() {
  if (openclawConfig.escalationMode === 'off') return;
  if (!openclawConfig.gatewayToken && !openclawConfig.hookUrl) return;
  if (openclawWs) return;

  try {
    const wsUrl = openclawConfig.gatewayWsUrl;
    openclawWs = new WebSocket(wsUrl);
    openclawAuthenticated = false;

    openclawWs.onopen = () => {
      console.log(`[openclaw] ws connected: ${wsUrl} (awaiting challenge)`);
    };

    openclawWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));

        // Handle connect.challenge — respond with connect request
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const nonce = msg.payload?.nonce;
          console.log(`[openclaw] received challenge, authenticating...`);
          openclawWs.send(JSON.stringify({
            type: 'req',
            id: 'connect-1',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'gateway-client',
                displayName: 'Sinain HUD Relay',
                version: '1.0.0',
                platform: process.platform,
                mode: 'backend',
              },
              auth: {
                token: openclawConfig.gatewayToken,
              },
            },
          }));
          return;
        }

        // Handle connect response
        if (msg.type === 'res' && msg.id === 'connect-1') {
          if (msg.ok) {
            openclawAuthenticated = true;
            console.log('[openclaw] gateway authenticated');
          } else {
            console.error('[openclaw] auth failed:', msg.error || msg.payload?.error || 'unknown');
            openclawWs.close();
          }
          return;
        }

        // Handle RPC responses
        const msgId = msg.id != null ? String(msg.id) : null;
        if (msg.type === 'res' && msgId && openclawPending.has(msgId)) {
          const pending = openclawPending.get(msgId);
          // Skip intermediate "accepted" frame when expecting a final frame
          if (pending.expectFinal && msg.payload?.status === 'accepted') {
            console.log(`[openclaw] rpc ${msgId}: accepted (waiting for final)`);
            return;
          }
          clearTimeout(pending.timeout);
          openclawPending.delete(msgId);
          pending.resolve(msg);
        }
      } catch (err) {
        console.error('[openclaw] ws message handler error:', err);
      }
    };

    openclawWs.onclose = () => {
      console.log('[openclaw] gateway disconnected');
      openclawWs = null;
      openclawAuthenticated = false;
      // Reject all orphaned pending RPCs so they fail fast instead of hanging
      for (const [id, pending] of openclawPending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('gateway disconnected'));
      }
      openclawPending.clear();
      // Reconnect after 10s
      if (openclawConfig.escalationMode !== 'off') {
        if (openclawReconnectTimer) clearTimeout(openclawReconnectTimer);
        openclawReconnectTimer = setTimeout(connectOpenClawGateway, 10000);
      }
    };

    openclawWs.onerror = (err) => {
      // Only log — cleanup and reconnect are handled exclusively by onclose
      console.error('[openclaw] ws error:', err.message || 'connection failed');
    };
  } catch (err) {
    console.error('[openclaw] connect failed:', err.message);
    openclawWs = null;
  }
}

function sendGatewayRpc(method, params, timeoutMs = 90000, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!openclawWs || openclawWs.readyState !== WebSocket.OPEN || !openclawAuthenticated) {
      reject(new Error('gateway not connected or not authenticated'));
      return;
    }

    const id = String(openclawRpcId++);
    const timeout = setTimeout(() => {
      openclawPending.delete(id);
      reject(new Error(`rpc timeout: ${method}`));
    }, timeoutMs);

    openclawPending.set(id, {
      resolve, reject, timeout,
      expectFinal: !!opts.expectFinal,
    });

    openclawWs.send(JSON.stringify({
      type: 'req',
      method,
      id,
      params,
    }));
  });
}

function disconnectOpenClawGateway() {
  if (openclawReconnectTimer) { clearTimeout(openclawReconnectTimer); openclawReconnectTimer = null; }
  if (openclawWs) { try { openclawWs.close(); } catch {} openclawWs = null; }
  openclawAuthenticated = false;
  for (const [id, { reject, timeout }] of openclawPending) {
    clearTimeout(timeout);
    reject(new Error('disconnected'));
  }
  openclawPending.clear();
}

// ── Escalation Logic ──

function shouldEscalate(digest, hud, contextWindow) {
  if (openclawConfig.escalationMode === 'off') return false;

  // Cooldown check
  const now = Date.now();
  if (now - escalationStats.lastEscalationTs < openclawConfig.escalationCooldownMs) return false;

  // Don't escalate idle
  if (hud === 'Idle' || hud === '\u2014') return false;

  // Don't re-escalate identical digests
  if (digest === lastEscalatedDigest) return false;

  if (openclawConfig.escalationMode === 'focus') {
    // Focus mode: escalate every meaningful change
    return true;
  }

  // Selective mode: score-based escalation
  const digestLower = digest.toLowerCase();
  let score = 0;

  // Error indicators (+3)
  const errorPatterns = ['error', 'failed', 'failure', 'exception', 'crash', 'traceback',
    'typeerror', 'referenceerror', 'syntaxerror', 'cannot read', 'undefined is not',
    'exit code', 'segfault', 'panic', 'fatal'];
  for (const p of errorPatterns) {
    if (digestLower.includes(p)) { score += 3; break; }
  }

  // Question/help indicators in audio (+2)
  const questionPatterns = ['how do i', 'how to', 'what if', 'why is', 'help me',
    'not working', 'stuck', 'confused', 'any ideas', 'suggestions'];
  for (const e of contextWindow.audio) {
    const text = (e.text || '').toLowerCase();
    for (const p of questionPatterns) {
      if (text.includes(p)) { score += 2; break; }
    }
  }

  // Complex code indicators (+1)
  const complexPatterns = ['todo', 'fixme', 'hack', 'workaround', 'deprecated'];
  for (const p of complexPatterns) {
    if (digestLower.includes(p)) { score += 1; break; }
  }

  // Significant app switches in context (+1)
  if (contextWindow.appHistory.length >= 4) score += 1;

  return score >= 3;
}

function buildEscalationMessage(digest, contextWindow, entry) {
  const currentApp = normalizeAppName(contextWindow.currentApp);
  const parts = [];
  parts.push(`**Digest:** ${digest}`);
  parts.push(`**Current app:** ${currentApp}`);
  if (contextWindow.appHistory.length > 0) {
    parts.push(`**App history:** ${contextWindow.appHistory.map(a => normalizeAppName(a.app)).join(' → ')}`);
  }
  if (contextWindow.screen.length > 0) {
    parts.push('**Screen (OCR):**');
    for (const e of contextWindow.screen.slice(0, 10)) {
      const app = normalizeAppName(e.app);
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, ' ').slice(0, 400) : '(no text)';
      parts.push(`- [${ago}s ago] [${app}] ${ocr}`);
    }
  }
  if (contextWindow.audio.length > 0) {
    parts.push('**Audio transcripts:**');
    for (const e of contextWindow.audio.slice(0, 5)) {
      const ago = Math.round((Date.now() - (e.ts || Date.now())) / 1000);
      parts.push(`- [${ago}s ago] ${e.text.slice(0, 400)}`);
    }
  }

  const instructions = openclawConfig.escalationMode === 'focus'
    ? `Based on the above, always provide a brief response for the user's HUD:
- If there's an error: investigate and suggest a fix
- If they seem stuck: offer guidance
- If they're coding: provide relevant insights
- Otherwise: briefly note what the user is doing and any observations
- Keep your response concise (1-3 sentences)`
    : `Based on the above, proactively help the user:
- If there's an error: investigate and suggest a fix
- If they seem stuck: offer guidance
- If they're coding: provide relevant insights
- Keep your response concise and actionable (1-3 sentences)`;

  return `[sinain-hud live context — tick #${entry.id}]

${parts.join('\n')}

${instructions}

Respond naturally — this will appear on the user's HUD overlay.`;
}

async function escalateViaHttp(message) {
  try {
    const hookResp = await fetch(openclawConfig.hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(openclawConfig.hookToken ? { 'Authorization': `Bearer ${openclawConfig.hookToken}` } : {}),
      },
      body: JSON.stringify({
        message,
        name: 'sinain-hud',
        sessionKey: openclawConfig.sessionKey,
        wakeMode: 'now',
        deliver: false,
      }),
    });

    if (!hookResp.ok) {
      const body = await hookResp.text().catch(() => '');
      console.error(`[openclaw] HTTP hook failed: ${hookResp.status} ${body.slice(0, 200)}`);
      return false;
    }
    console.log('[openclaw] escalated via HTTP (fire-and-forget)');
    return true;
  } catch (err) {
    console.error('[openclaw] HTTP hook error:', err.message);
    return false;
  }
}

function pushAgentResponse(output) {
  const msg = {
    id: nextId++,
    text: `[🤖] ${output.trim().slice(0, 2000)}`,
    priority: 'high',
    ts: Date.now(),
    source: 'openclaw',
  };
  messages.push(msg);
  if (messages.length > 100) messages.splice(0, messages.length - 100);
  feedVersion++;
  escalationStats.totalResponses++;
  escalationStats.lastResponseTs = Date.now();
  console.log(`[openclaw] response pushed to feed: "${output.slice(0, 80)}..."`);
}

function escalateToOpenClaw(digest, contextWindow, entry) {
  if (!openclawConfig.hookUrl && !openclawWs) {
    console.log('[openclaw] escalation skipped: no hookUrl and no WS connection');
    return;
  }

  // Mark cooldown immediately so agentTick() isn't blocked and future ticks
  // don't re-escalate while we're waiting for the agent response
  escalationStats.totalEscalations++;
  escalationStats.lastEscalationTs = Date.now();
  lastEscalatedDigest = digest;

  const message = buildEscalationMessage(digest, contextWindow, entry);
  const idemKey = `hud-${entry.id}-${Date.now()}`;

  // Fire and handle asynchronously — don't block the agent tick loop
  _doEscalate(message, idemKey).catch(err => {
    console.error('[openclaw] escalation error:', err.message);
  });
}

async function _doEscalate(message, idemKey) {
  // Primary path: WS `agent` RPC (returns full output via two-frame protocol)
  if (openclawWs && openclawWs.readyState === WebSocket.OPEN && openclawAuthenticated) {
    try {
      const result = await sendGatewayRpc('agent', {
        message,
        idempotencyKey: idemKey,
        sessionKey: openclawConfig.sessionKey,
        deliver: false,
      }, 120000, { expectFinal: true });

      if (result.ok && result.payload) {
        const p = result.payload;
        console.log(`[openclaw] escalated via WS agent RPC → runId=${p.runId}, status=${p.status}`);

        // Dump full structure once (ever) for remote diagnostics
        if (!firstEscalationStructureDumped) {
          firstEscalationStructureDumped = true;
          const structDump = JSON.stringify(p, null, 2).slice(0, 800);
          const dbgMsg = { id: nextId++, text: `[🤖 dbg] first RPC result structure:\n${structDump}`, priority: 'low', ts: Date.now(), source: 'openclaw' };
          messages.push(dbgMsg);
          if (messages.length > 100) messages.splice(0, messages.length - 100);
          feedVersion++;
        }

        // Extract text from payload.result.payloads[].text
        const payloads = p.result?.payloads;
        if (Array.isArray(payloads) && payloads.length > 0) {
          const output = payloads.map(pl => pl.text || '').join('\n').trim();
          if (output) {
            pushAgentResponse(output);
          } else {
            // Payloads exist but all text empty (unexpected)
            escalationStats.totalNoReply++;
            const sampleKeys = payloads.map(pl => Object.keys(pl)).slice(0, 3);
            console.log(`[openclaw] empty text in ${payloads.length} payloads, keys: ${JSON.stringify(sampleKeys)}`);
          }
        } else {
          // Empty payloads = agent said NO_REPLY (expected for non-actionable context)
          escalationStats.totalNoReply++;
          console.log(`[openclaw] agent returned no payloads (NO_REPLY)`);
        }
      } else if (!result.ok) {
        const errDetail = JSON.stringify(result.error || result.payload);
        console.log(`[openclaw] agent RPC error: ${errDetail}`);
        // Push error to feed for remote debugging
        const errMsg = { id: nextId++, text: `[🤖 err] ${errDetail.slice(0, 500)}`, priority: 'low', ts: Date.now(), source: 'openclaw' };
        messages.push(errMsg);
        if (messages.length > 100) messages.splice(0, messages.length - 100);
        feedVersion++;
        escalationStats.totalErrors++;
      }
      return; // WS path completed, don't fall through
    } catch (err) {
      console.log(`[openclaw] agent RPC failed: ${err.message} — falling back to HTTP`);
      const errMsg = { id: nextId++, text: `[🤖 err] RPC exception: ${err.message}`, priority: 'low', ts: Date.now(), source: 'openclaw' };
      messages.push(errMsg);
      if (messages.length > 100) messages.splice(0, messages.length - 100);
      feedVersion++;
      // Fall through to HTTP fallback
    }
  }

  // Fallback path: HTTP POST (fire-and-forget, no response capture)
  if (openclawConfig.hookUrl) {
    const ok = await escalateViaHttp(message);
    if (!ok) escalationStats.totalErrors++;
  } else {
    console.log('[openclaw] no WS and no hookUrl — escalation skipped');
  }
}

// ── LLM Call ──

async function callAgent(contextWindow) {
  const prompt = buildPrompt(contextWindow);

  if (agentConfig.logVerbose) {
    console.log('[agent] prompt:', prompt);
  }

  // Model chain: primary model + fallbacks
  const models = [agentConfig.model, ...agentConfig.fallbackModels];
  let lastError = null;

  for (const model of models) {
    try {
      const result = await callAgentWithModel(prompt, model);
      return result;
    } catch (err) {
      lastError = err;
      console.log(`[agent] model ${model} failed: ${err.message || err}, trying next...`);
    }
  }

  throw lastError || new Error('all models failed');
}

async function callAgentWithModel(prompt, model) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentConfig.openrouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const latencyMs = Date.now() - start;
    const raw = data.choices?.[0]?.message?.content?.trim() || '';

    if (agentConfig.logVerbose) {
      console.log('[agent] response:', JSON.stringify(data, null, 2));
    }

    try {
      const jsonStr = raw.replace(/^```\w*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
      const parsed = JSON.parse(jsonStr);
      agentStats.parseSuccesses++;
      return {
        hud: parsed.hud || '—',
        digest: parsed.digest || '—',
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: true,
      };
    } catch {
      // Second-chance: try extracting an embedded JSON object from raw text
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.hud) {
            agentStats.parseSuccesses++;
            return {
              hud: parsed.hud,
              digest: parsed.digest || '—',
              latencyMs,
              tokensIn: data.usage?.prompt_tokens || 0,
              tokensOut: data.usage?.completion_tokens || 0,
              model,
              parsedOk: true,
            };
          }
        } catch {}
      }
      // Final fallback
      agentStats.parseFailures++;
      console.log(`[agent] JSON parse failed (model=${model}), raw: "${raw.slice(0, 120)}"`);
      return {
        hud: raw.slice(0, 80) || '—',
        digest: raw || '—',
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: false,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── Agent Tick ──

async function agentTick() {
  // Skip if no API key
  if (!agentConfig.openrouterApiKey) return;

  // Idle suppression: skip if no new events since last tick
  if (feedVersion === lastTickFeedVersion && senseVersion === lastTickSenseVersion) {
    agentStats.idleSkips++;
    if (agentConfig.logVerbose) console.log('[agent] idle — skipping tick');
    return;
  }
  lastTickFeedVersion = feedVersion;
  lastTickSenseVersion = senseVersion;

  const contextWindow = buildContextWindow(agentConfig.maxAgeMs);

  // Skip if both buffers empty in window
  if (contextWindow.audioCount === 0 && contextWindow.screenCount === 0) {
    agentStats.idleSkips++;
    if (agentConfig.logVerbose) console.log('[agent] empty context — skipping');
    return;
  }

  try {
    const result = await callAgent(contextWindow);
    const { hud, digest, latencyMs, tokensIn, tokensOut, model: usedModel, parsedOk } = result;

    // Track context freshness
    const contextFreshness = contextWindow.newestEventTs
      ? Date.now() - contextWindow.newestEventTs
      : null;

    // Track HUD staleness
    if (hud === lastPushedHud) {
      agentStats.consecutiveIdenticalHud++;
    } else {
      agentStats.consecutiveIdenticalHud = 0;
      agentStats.hudChanges++;
    }

    // Update stats
    agentStats.totalCalls++;
    agentStats.totalTokensIn += tokensIn;
    agentStats.totalTokensOut += tokensOut;
    agentStats.lastAnalysisTs = Date.now();

    // Store result
    const entry = {
      id: agentNextId++,
      ts: Date.now(),
      hud,
      digest,
      context: {
        currentApp: contextWindow.currentApp,
        appHistory: contextWindow.appHistory.map(a => a.app),
        audioCount: contextWindow.audioCount,
        screenCount: contextWindow.screenCount,
      },
      pushed: false,
      model: usedModel || agentConfig.model,
      latencyMs,
      tokensIn,
      tokensOut,
      parsedOk,
      contextFreshnessMs: contextFreshness,
    };
    agentBuffer.push(entry);
    if (agentBuffer.length > MAX_AGENT_RESULTS) agentBuffer.shift();

    console.log(`[agent] #${entry.id} (${latencyMs}ms, ${tokensIn}+${tokensOut}tok, model=${usedModel}) hud="${hud}"`);

    // Auto-push HUD line to feed (suppress "—" and "Idle")
    if (agentConfig.pushToFeed && hud !== '—' && hud !== 'Idle' && hud !== lastPushedHud) {
      const msg = {
        id: nextId++,
        text: `[🧠] ${hud}`,
        priority: 'normal',
        ts: Date.now(),
        source: 'agent',
      };
      messages.push(msg);
      if (messages.length > 100) messages.splice(0, messages.length - 100);
      feedVersion++;
      lastPushedHud = hud;
      entry.pushed = true;
      console.log(`[agent] → HUD: ${hud}`);
    }

    // Store digest for Sinain
    latestDigest = {
      id: entry.id,
      ts: entry.ts,
      digest,
      currentApp: contextWindow.currentApp,
      appHistory: contextWindow.appHistory,
      latencyMs,
    };

    // Write SITUATION.md for OpenClaw bootstrap
    writeSituationMd(contextWindow, digest, entry);

    // Escalate to OpenClaw if warranted
    if (shouldEscalate(digest, hud, contextWindow)) {
      escalateToOpenClaw(digest, contextWindow, entry);
    }

    if (agentConfig.logVerbose) {
      console.log(`[agent] digest: "${digest.slice(0, 100)}..."`);
    }
  } catch (err) {
    console.error('[agent] tick error:', err.message || err);
  }
}

// ── Agent Loop (debounce-based) ──

function scheduleAgentTick() {
  if (!agentConfig.enabled || !agentConfig.openrouterApiKey) return;

  if (agentDebounceTimer) {
    clearTimeout(agentDebounceTimer);
  }

  agentDebounceTimer = setTimeout(() => {
    agentDebounceTimer = null;
    agentTick();
  }, agentConfig.debounceMs);
}

function startAgentLoop() {
  if (agentTimer) clearInterval(agentTimer);
  if (agentDebounceTimer) clearTimeout(agentDebounceTimer);
  if (agentMaxIntervalTimer) clearInterval(agentMaxIntervalTimer);

  agentMaxIntervalTimer = setInterval(() => {
    if (!agentDebounceTimer) {
      agentTick();
    }
  }, agentConfig.maxIntervalMs);

  agentTimer = null;
  console.log(`[agent] loop started (debounce=${agentConfig.debounceMs}ms, max=${agentConfig.maxIntervalMs}ms, model=${agentConfig.model})`);
}

function stopAgentLoop() {
  if (agentTimer) { clearInterval(agentTimer); agentTimer = null; }
  if (agentDebounceTimer) { clearTimeout(agentDebounceTimer); agentDebounceTimer = null; }
  if (agentMaxIntervalTimer) { clearInterval(agentMaxIntervalTimer); agentMaxIntervalTimer = null; }
  console.log('[agent] loop stopped');
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  // --- /feed endpoints ---

  if (req.method === 'GET' && req.url?.startsWith('/feed')) {
    const url = new URL(req.url, 'http://localhost');
    const after = parseInt(url.searchParams.get('after') || '0');
    // Filter out [PERIODIC] audio transcript items from overlay responses —
    // they stay in the messages array for the agent LLM (buildContextWindow)
    const items = messages.filter(m => m.id > after && !m.text.startsWith('[PERIODIC]'));
    res.end(JSON.stringify({ messages: items, epoch: serverEpoch }));
    return;
  }

  if (req.method === 'POST' && req.url === '/feed') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text, priority } = JSON.parse(body);
        const msg = { id: nextId++, text, priority: priority || 'normal', ts: Date.now() };
        messages.push(msg);
        if (messages.length > 100) messages.splice(0, messages.length - 100);
        feedVersion++;
        console.log(`[feed] #${msg.id} (${msg.priority}): ${text?.slice(0, 80)}`);
        res.end(JSON.stringify({ ok: true, id: msg.id }));
        scheduleAgentTick();
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  // --- /sense endpoints ---

  if (req.method === 'POST' && req.url === '/sense') {
    try {
      const body = await readBody(req, MAX_SENSE_BODY);
      const data = JSON.parse(body);
      if (!data.type || !data.ts) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'missing type or ts' }));
        return;
      }
      const event = { id: senseNextId++, ...data, receivedAt: Date.now() };
      senseBuffer.push(event);
      if (senseBuffer.length > MAX_SENSE_EVENTS) senseBuffer.shift();
      senseVersion++;
      console.log(`[sense] #${event.id} (${event.type}): app=${event.meta?.app || '?'} ssim=${event.meta?.ssim?.toFixed(3) || '?'}`);
      res.end(JSON.stringify({ ok: true, id: event.id }));
      scheduleAgentTick();
    } catch (e) {
      res.statusCode = e.message === 'body too large' ? 413 : 400;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/sense')) {
    const url = new URL(req.url, 'http://localhost');
    const after = parseInt(url.searchParams.get('after') || '0');
    const metaOnly = url.searchParams.get('meta_only') === 'true';
    let events = senseBuffer.filter(e => e.id > after);
    if (metaOnly) {
      events = events.map(stripImageData);
    }
    res.end(JSON.stringify({ events, epoch: serverEpoch }));
    return;
  }

  // --- /agent endpoints ---

  if (req.method === 'GET' && req.url === '/agent/digest') {
    res.end(JSON.stringify({ ok: true, digest: latestDigest }));
    return;
  }

  if (req.method === 'GET' && req.url === '/agent/last') {
    const last = agentBuffer[agentBuffer.length - 1] || null;
    res.end(JSON.stringify({ ok: true, result: last }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/agent/history')) {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), MAX_AGENT_RESULTS);
    const results = agentBuffer.slice(-limit).reverse();
    res.end(JSON.stringify({ ok: true, results }));
    return;
  }

  if (req.method === 'GET' && req.url === '/agent/context') {
    const context = buildContextWindow(agentConfig.maxAgeMs);
    res.end(JSON.stringify({ ok: true, context }));
    return;
  }

  if (req.method === 'GET' && req.url === '/agent/config') {
    const { openrouterApiKey, ...safeConfig } = agentConfig;
    res.end(JSON.stringify({ ok: true, config: { ...safeConfig, hasApiKey: !!openrouterApiKey } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/agent/config') {
    try {
      const body = await readBody(req, 4096);
      const updates = JSON.parse(body);

      if (updates.enabled !== undefined) agentConfig.enabled = !!updates.enabled;
      if (updates.intervalMs !== undefined) agentConfig.intervalMs = Math.max(5000, parseInt(updates.intervalMs));
      if (updates.model !== undefined) agentConfig.model = String(updates.model);
      if (updates.maxAge !== undefined) agentConfig.maxAgeMs = Math.max(10000, parseInt(updates.maxAge));
      if (updates.pushToFeed !== undefined) agentConfig.pushToFeed = !!updates.pushToFeed;
      if (updates.temperature !== undefined) agentConfig.temperature = parseFloat(updates.temperature);
      if (updates.openrouterApiKey !== undefined) agentConfig.openrouterApiKey = String(updates.openrouterApiKey);
      if (updates.debounceMs !== undefined) agentConfig.debounceMs = Math.max(1000, parseInt(updates.debounceMs));
      if (updates.maxIntervalMs !== undefined) agentConfig.maxIntervalMs = Math.max(5000, parseInt(updates.maxIntervalMs));
      if (updates.fallbackModels !== undefined) agentConfig.fallbackModels = Array.isArray(updates.fallbackModels) ? updates.fallbackModels : [];
      if (updates.escalationMode !== undefined) {
        const mode = String(updates.escalationMode);
        if (['focus', 'selective', 'off'].includes(mode)) {
          openclawConfig.escalationMode = mode;
          if (mode !== 'off' && !openclawWs) connectOpenClawGateway();
          if (mode === 'off') disconnectOpenClawGateway();
          console.log(`[openclaw] escalation mode: ${mode}`);
        }
      }
      if (updates.escalationCooldownMs !== undefined) openclawConfig.escalationCooldownMs = Math.max(5000, parseInt(updates.escalationCooldownMs));

      // Restart or stop loop based on enabled state
      if (agentConfig.enabled && agentConfig.openrouterApiKey) {
        startAgentLoop();
      } else {
        stopAgentLoop();
      }

      const { openrouterApiKey, ...safeConfig } = agentConfig;
      res.end(JSON.stringify({ ok: true, config: { ...safeConfig, hasApiKey: !!openrouterApiKey } }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- /health ---

  if (req.method === 'GET' && req.url === '/health') {
    const costPerToken = { in: 0.075 / 1_000_000, out: 0.3 / 1_000_000 }; // gemini-2.5-flash-lite approx
    const estimatedCost =
      agentStats.totalTokensIn * costPerToken.in +
      agentStats.totalTokensOut * costPerToken.out;

    res.end(JSON.stringify({
      ok: true,
      epoch: serverEpoch,
      messages: messages.length,
      senseEvents: senseBuffer.length,
      agent: {
        enabled: agentConfig.enabled,
        lastAnalysis: agentStats.lastAnalysisTs || null,
        lastDigest: latestDigest?.digest?.slice(0, 200) || null,
        totalCalls: agentStats.totalCalls,
        totalTokens: { in: agentStats.totalTokensIn, out: agentStats.totalTokensOut },
        estimatedCost: Math.round(estimatedCost * 1000000) / 1000000,
        model: agentConfig.model,
        idleSkips: agentStats.idleSkips,
        parseSuccessRate: agentStats.parseSuccesses + agentStats.parseFailures > 0
          ? Math.round((agentStats.parseSuccesses / (agentStats.parseSuccesses + agentStats.parseFailures)) * 100)
          : null,
        hudChangeRate: agentStats.hudChanges,
        consecutiveIdenticalHud: agentStats.consecutiveIdenticalHud,
        debounceMs: agentConfig.debounceMs,
        fallbackModels: agentConfig.fallbackModels,
      },
      escalation: {
        mode: openclawConfig.escalationMode,
        gatewayConnected: !!(openclawWs && openclawWs.readyState === WebSocket.OPEN),
        cooldownMs: openclawConfig.escalationCooldownMs,
        totalEscalations: escalationStats.totalEscalations,
        totalResponses: escalationStats.totalResponses,
        totalErrors: escalationStats.totalErrors,
        totalNoReply: escalationStats.totalNoReply,
        lastEscalationTs: escalationStats.lastEscalationTs || null,
        lastResponseTs: escalationStats.lastResponseTs || null,
      },
      situation: {
        enabled: situationConfig.enabled,
        workspaceDir: situationConfig.workspaceDir,
      },
    }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(18791, '0.0.0.0', () => {
  console.log(`[hud-relay] listening on http://0.0.0.0:18791 (epoch=${serverEpoch})`);

  // Start agent loop if enabled and API key present
  if (agentConfig.enabled && agentConfig.openrouterApiKey) {
    startAgentLoop();
  } else if (agentConfig.enabled && !agentConfig.openrouterApiKey) {
    console.warn('[agent] AGENT_ENABLED=true but OPENROUTER_API_KEY not set — agent disabled');
    agentConfig.enabled = false;
  } else {
    console.log('[agent] disabled (set AGENT_ENABLED=true and OPENROUTER_API_KEY to enable)');
  }

  // Connect to OpenClaw gateway for escalation
  if (openclawConfig.escalationMode !== 'off') {
    console.log(`[openclaw] escalation mode: ${openclawConfig.escalationMode}`);
    console.log(`[situation] writing to: ${situationConfig.workspaceDir}/SITUATION.md (enabled=${situationConfig.enabled})`);
    connectOpenClawGateway();
  } else {
    console.log('[openclaw] escalation disabled');
  }
});
