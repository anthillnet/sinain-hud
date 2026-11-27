// Inspect OverlayShellState fields in the running overlay, optionally tap.
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
    const classList = await rpc('getClassList', { isolateId });
    const cls = classList.classes.find((c) => c.name === 'OverlayShellState');
    if (!cls) throw new Error('OverlayShellState class not found');
    const inst = await rpc('getInstances', { isolateId, objectId: cls.id, limit: 3 });
    if (!inst.instances?.length) throw new Error('no instances');
    const stateId = inst.instances[0].id;
    const evalOn = async (expr) => {
      const r = await rpc('evaluate', { isolateId, targetId: stateId, expression: expr });
      return r.valueAsString ?? JSON.stringify(r);
    };
    console.log(await evalOn(
      "'view=$_islandView parked=$_parked inFlight=$_windowOpInFlight menuOpen=$_islandContextMenuOpen'"));
    if (process.argv[3] === 'collapse') {
      console.log('calling _collapseIsland()');
      console.log(await evalOn("(this.._collapseIsland()) == null"));
      await sleep(1500);
      console.log(await evalOn(
        "'view=$_islandView parked=$_parked inFlight=$_windowOpInFlight'"));
    }
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
};
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1); };
