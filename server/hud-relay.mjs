import http from 'http';

// Simple HUD relay — I push messages, bridge polls them
const messages = [];
let nextId = 1;

// Sense event ring buffer (screen capture pipeline)
const senseBuffer = [];
let senseNextId = 1;
const MAX_SENSE_EVENTS = 30;
const MAX_SENSE_BODY = 2 * 1024 * 1024; // 2MB

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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // --- /feed endpoints (existing) ---

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

  // --- /sense endpoints (screen capture pipeline) ---

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

  // --- /health ---

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, messages: messages.length, senseEvents: senseBuffer.length }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(18791, '0.0.0.0', () => {
  console.log('[hud-relay] listening on http://0.0.0.0:18791');
});
