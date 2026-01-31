import http from 'http';

// Simple HUD relay — I push messages, bridge polls them
const messages = [];
let nextId = 1;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
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
        // Keep last 100
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
  
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, messages: messages.length }));
    return;
  }
  
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(18791, '0.0.0.0', () => {
  console.log('[hud-relay] listening on http://0.0.0.0:18791');
});
