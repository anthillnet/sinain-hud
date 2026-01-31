import http from 'http';

// ── Feed ring buffer (existing) ──
const messages = [];
let nextId = 1;

// ── Sense event ring buffer (screen capture pipeline) ──
const senseBuffer = [];
let senseNextId = 1;
const MAX_SENSE_EVENTS = 30;
const MAX_SENSE_BODY = 2 * 1024 * 1024; // 2MB

// ── Agent analysis loop ──
const agentBuffer = [];
const MAX_AGENT_RESULTS = 50;
let agentNextId = 1;
let agentTimer = null;
let lastPushedAnalysis = '';
let lastTickFeedLen = 0;
let lastTickSenseLen = 0;

const agentStats = {
  totalCalls: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  lastAnalysisTs: 0,
};

const agentConfig = {
  enabled: env('AGENT_ENABLED', 'false') === 'true',
  intervalMs: intEnv('AGENT_INTERVAL_MS', 10000),
  model: env('AGENT_MODEL', 'google/gemini-2.5-flash-lite'),
  openrouterApiKey: env('OPENROUTER_API_KEY', ''),
  maxAgeMs: intEnv('AGENT_MAX_AGE_MS', 120000),
  maxTokens: intEnv('AGENT_MAX_TOKENS', 100),
  temperature: parseFloat(env('AGENT_TEMPERATURE', '0.3')),
  pushToFeed: env('AGENT_PUSH_TO_FEED', 'true') === 'true',
  logVerbose: env('AGENT_LOG_VERBOSE', 'false') === 'true',
};

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

  return {
    currentApp,
    audio: audioEvents.slice(-5),
    screen: dedupedScreen.slice(-10),
    audioCount: audioEvents.length,
    screenCount: screenEvents.length,
    windowMs: maxAgeMs,
  };
}

// ── LLM Call ──

async function callAgent(contextWindow) {
  const screenLines = contextWindow.screen
    .map(e => `[${e.app}] ${e.ocr.slice(0, 120)}`)
    .join('\n');

  const audioLines = contextWindow.audio
    .map(e => e.text.slice(0, 200))
    .join('\n');

  const prompt = `You are Sinain, an AI monitoring a user's screen and audio in real-time.

Active app: ${contextWindow.currentApp}

Screen activity (OCR, newest last):
${screenLines || '(no screen data)'}

Audio (transcript, newest last):
${audioLines || '(silence)'}

Task: In 1-2 SHORT sentences:
1. What is the user doing right now?
2. One specific, actionable suggestion if you can help. If nothing useful, say "—".

Rules:
- Be terse. Max 30 words total.
- No filler. Just state it.
- If screen shows code errors, suggest a fix.
- If audio is a lecture, note the topic.
- If nothing interesting, respond with just "—".`;

  if (agentConfig.logVerbose) {
    console.log('[agent] prompt:', prompt);
  }

  const start = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${agentConfig.openrouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agentConfig.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: agentConfig.maxTokens,
      temperature: agentConfig.temperature,
    }),
  });

  const data = await response.json();
  const latencyMs = Date.now() - start;
  const tokensIn = data.usage?.prompt_tokens || 0;
  const tokensOut = data.usage?.completion_tokens || 0;
  const analysis = data.choices?.[0]?.message?.content?.trim() || '—';

  if (agentConfig.logVerbose) {
    console.log('[agent] response:', JSON.stringify(data, null, 2));
  }

  return { analysis, latencyMs, tokensIn, tokensOut };
}

// ── Agent Tick ──

async function agentTick() {
  // Skip if no API key
  if (!agentConfig.openrouterApiKey) return;

  // Idle suppression: skip if no new events since last tick
  if (messages.length === lastTickFeedLen && senseBuffer.length === lastTickSenseLen) {
    if (agentConfig.logVerbose) console.log('[agent] idle — skipping tick');
    return;
  }
  lastTickFeedLen = messages.length;
  lastTickSenseLen = senseBuffer.length;

  const contextWindow = buildContextWindow(agentConfig.maxAgeMs);

  // Skip if both buffers empty in window
  if (contextWindow.audioCount === 0 && contextWindow.screenCount === 0) {
    if (agentConfig.logVerbose) console.log('[agent] empty context — skipping');
    return;
  }

  try {
    const { analysis, latencyMs, tokensIn, tokensOut } = await callAgent(contextWindow);

    // Update stats
    agentStats.totalCalls++;
    agentStats.totalTokensIn += tokensIn;
    agentStats.totalTokensOut += tokensOut;
    agentStats.lastAnalysisTs = Date.now();

    const pushed = agentConfig.pushToFeed
      && analysis !== '—'
      && analysis !== lastPushedAnalysis;

    // Store result
    const result = {
      id: agentNextId++,
      ts: Date.now(),
      analysis,
      context: {
        currentApp: contextWindow.currentApp,
        audioCount: contextWindow.audioCount,
        screenCount: contextWindow.screenCount,
      },
      pushed,
      model: agentConfig.model,
      latencyMs,
      tokensIn,
      tokensOut,
    };
    agentBuffer.push(result);
    if (agentBuffer.length > MAX_AGENT_RESULTS) agentBuffer.shift();

    console.log(`[agent] #${result.id} (${latencyMs}ms, ${tokensIn}+${tokensOut}tok): ${analysis.slice(0, 80)}`);

    // Auto-push to feed
    if (pushed) {
      const msg = {
        id: nextId++,
        text: `[🧠] ${analysis}`,
        priority: 'normal',
        ts: Date.now(),
        source: 'agent',
      };
      messages.push(msg);
      if (messages.length > 100) messages.splice(0, messages.length - 100);
      lastPushedAnalysis = analysis;
      console.log(`[agent] → pushed to feed #${msg.id}`);
    }
  } catch (err) {
    console.error('[agent] tick error:', err.message || err);
    // Back off: double interval on error, cap at 60s
    if (agentTimer && agentConfig.intervalMs < 60000) {
      clearInterval(agentTimer);
      agentConfig.intervalMs = Math.min(agentConfig.intervalMs * 2, 60000);
      agentTimer = setInterval(agentTick, agentConfig.intervalMs);
      console.log(`[agent] backed off to ${agentConfig.intervalMs}ms interval`);
    }
  }
}

function startAgentLoop() {
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = setInterval(agentTick, agentConfig.intervalMs);
  console.log(`[agent] loop started (${agentConfig.intervalMs}ms, model=${agentConfig.model})`);
}

function stopAgentLoop() {
  if (agentTimer) {
    clearInterval(agentTimer);
    agentTimer = null;
  }
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
    const items = messages.filter(m => m.id > after);
    res.end(JSON.stringify({ messages: items }));
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
        console.log(`[feed] #${msg.id} (${msg.priority}): ${text?.slice(0, 80)}`);
        res.end(JSON.stringify({ ok: true, id: msg.id }));
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
      console.log(`[sense] #${event.id} (${event.type}): app=${event.meta?.app || '?'} ssim=${event.meta?.ssim?.toFixed(3) || '?'}`);
      res.end(JSON.stringify({ ok: true, id: event.id }));
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
    res.end(JSON.stringify({ events }));
    return;
  }

  // --- /agent endpoints ---

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
      messages: messages.length,
      senseEvents: senseBuffer.length,
      agent: {
        enabled: agentConfig.enabled,
        lastAnalysis: agentStats.lastAnalysisTs || null,
        totalCalls: agentStats.totalCalls,
        totalTokens: { in: agentStats.totalTokensIn, out: agentStats.totalTokensOut },
        estimatedCost: Math.round(estimatedCost * 1000000) / 1000000,
        model: agentConfig.model,
      },
    }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(18791, '0.0.0.0', () => {
  console.log('[hud-relay] listening on http://0.0.0.0:18791');

  // Start agent loop if enabled and API key present
  if (agentConfig.enabled && agentConfig.openrouterApiKey) {
    startAgentLoop();
  } else if (agentConfig.enabled && !agentConfig.openrouterApiKey) {
    console.warn('[agent] AGENT_ENABLED=true but OPENROUTER_API_KEY not set — agent disabled');
    agentConfig.enabled = false;
  } else {
    console.log('[agent] disabled (set AGENT_ENABLED=true and OPENROUTER_API_KEY to enable)');
  }
});
