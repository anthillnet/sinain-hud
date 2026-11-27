// Drive the running overlay through the Dart VM service: measure the island
// window, inject a click on the bar wing, and confirm the stack expands.
const WS_URL = process.argv[2];
const ws = new WebSocket(WS_URL);
let id = 0;
const pending = new Map();
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const reqId = String(++id);
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onopen = async () => {
  try {
    const vm = await rpc('getVM');
    const isolateId = vm.isolates[0].id;
    const isolate = await rpc('getIsolate', { isolateId });
    const gestures = isolate.libraries.find(
      (l) => l.uri === 'package:flutter/src/gestures/binding.dart');
    const shell = isolate.libraries.find(
      (l) => l.uri.endsWith('ui/overlay_shell.dart'));
    if (!gestures || !shell) throw new Error('libraries not found');

    const evalIn = async (target, expression) => {
      const r = await rpc('evaluate', { isolateId, targetId: target.id, expression });
      if (r.type === 'ErrorRef' || r.kind === 'Error') throw new Error(JSON.stringify(r));
      return r.valueAsString ?? JSON.stringify(r);
    };

    const size = () => evalIn(shell,
      "'${WidgetsBinding.instance.platformDispatcher.views.first.physicalSize / WidgetsBinding.instance.platformDispatcher.views.first.devicePixelRatio}'");

    const tap = (x, y) => evalIn(gestures,
      `(GestureBinding.instance..handlePointerEvent(PointerDownEvent(position: Offset(${x}, ${y})))..handlePointerEvent(PointerUpEvent(position: Offset(${x}, ${y})))) == null`);

    const s0 = await size();
    console.log('bar-view window size:', s0);
    const m = s0.match(/([\d.]+), ([\d.]+)/);
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    // Right wing: clear of the 46px eye on the left, vertically centered in the bar.
    const x = w - 30, y = Math.min(h - 4, 16);
    console.log(`tapping bar at (${x}, ${y})`);
    await tap(x, y);
    await sleep(1500);
    const s1 = await size();
    console.log('after click window size:', s1);
    console.log('tapping again to collapse');
    await tap(x, y);
    await sleep(1500);
    const s2 = await size();
    console.log('after second click window size:', s2);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
};
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1); };
