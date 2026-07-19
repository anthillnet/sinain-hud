// sinain-bridge managed
const SOURCE = "amp";

const baseUrl = `http://${process.env.SINAIN_HOST ?? '127.0.0.1'}:${process.env.SINAIN_PORT ?? '9500'}`;

async function send(hook_event_name, value = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${baseUrl}/agent/event`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        session_id: value.session_id ?? value.sessionId ?? value.session?.id,
        hook_event_name, source: SOURCE, ts: Date.now(), cwd: value.cwd ?? process.cwd(),
        tool_name: value.tool_name ?? value.toolName ?? value.tool,
        tool_input: value.tool_input ?? value.input ?? value.args,
        message: value.message,
      }),
    });
  } catch {} finally { clearTimeout(timer); }
}

export default function sinainAmp(amp) {
  try { amp?.on?.('tool.call', (event) => send('PreToolUse', event)); } catch {}
  try { amp?.on?.('session.start', (event) => send('SessionStart', event)); } catch {}
  try { amp?.on?.('session.end', (event) => send('Stop', event)); } catch {}
  try { amp?.on?.('stop', (event) => send('Stop', event)); } catch {}
}
