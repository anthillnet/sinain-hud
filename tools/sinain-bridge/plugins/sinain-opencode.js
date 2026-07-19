// sinain-bridge managed
const SOURCE = "opencode";

const host = process.env.SINAIN_HOST ?? '127.0.0.1';
const port = process.env.SINAIN_PORT ?? '9500';
const baseUrl = `http://${host}:${port}`;

async function post(path, frame, timeout, json = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return json ? await response.json() : undefined;
  } finally {
    clearTimeout(timer);
  }
}

function properties(value) {
  return value?.properties ?? value?.detail ?? value?.data ?? value ?? {};
}

function sessionId(value) {
  const data = properties(value);
  return data.session_id ?? data.sessionID ?? data.sessionId ?? data.session?.id ?? data.info?.sessionID
    ?? data.info?.session_id ?? data.info?.id ?? value?.session_id ?? value?.sessionID;
}

function frame(event, hookEventName, directory, extra = {}) {
  const data = properties(event);
  return {
    session_id: sessionId(event),
    hook_event_name: hookEventName,
    source: SOURCE,
    ts: Date.now(),
    cwd: data.cwd ?? data.directory ?? data.info?.directory ?? directory ?? process.cwd(),
    ...extra,
  };
}

async function sendEvent(event, hookEventName, directory, extra = {}) {
  try { await post('/agent/event', frame(event, hookEventName, directory, extra), 1500); } catch {}
}

function toolFields(input, output) {
  const data = properties(input);
  return {
    tool_name: data.tool_name ?? data.toolName ?? data.tool ?? input?.tool,
    tool_input: data.args ?? data.input ?? input?.args ?? output?.args,
    ...(output === undefined ? {} : {
      message: typeof output === 'string' ? output : output?.message ?? output?.output,
    }),
  };
}

function permissionId(value) {
  const data = properties(value);
  return data.permission_id ?? data.permissionID ?? data.permissionId ?? data.id ?? value?.id;
}

async function replyWithClient(client, id, reply) {
  if (!id || !client) return;
  try {
    if (typeof client.post === 'function') await client.post(`/permission/${id}/reply`, { reply });
    else if (typeof client.request === 'function') await client.request({ method: 'POST', path: `/permission/${id}/reply`, body: { reply } });
    else if (typeof client.permission?.reply === 'function') await client.permission.reply({ path: { id }, body: { reply } });
  } catch {}
}

export default async function sinainPlugin({ client, directory } = {}) {
  async function approve(input, output, canReturn = true) {
    try {
      const data = properties(input);
      const response = await post('/agent/approve', frame(input, 'PermissionRequest', directory, {
        ...toolFields(input),
        message: data.message ?? data.permission ?? data.description,
      }), 125000, true);
      const reply = { allow: 'once', always: 'always', deny: 'reject' }[response?.behavior];
      if (!reply) return undefined;
      if (output && typeof output === 'object') {
        if ('status' in output) output.status = reply;
        else if ('reply' in output) output.reply = reply;
      }
      if (!canReturn) await replyWithClient(client, permissionId(input), reply);
      return reply;
    } catch {
      return undefined;
    }
  }

  return {
    event: async ({ event } = {}) => {
      try {
        const type = event?.type ?? event?.name;
        const data = properties(event);
        if (type === 'session.start') await sendEvent(event, 'SessionStart', directory);
        else if (type === 'session.idle') await sendEvent(event, 'Stop', directory);
        else if (type === 'session.error') await sendEvent(event, 'StopFailure', directory, { message: data.message ?? data.error?.message });
        else if (type === 'message.updated' && (data.role ?? data.message?.role ?? data.info?.role) === 'user') {
          await sendEvent(event, 'UserPromptSubmit', directory, {
            message: data.content ?? data.message?.content ?? data.info?.content ?? data.text,
          });
        } else if (type === 'permission.asked' || type === 'permission.ask') await approve(event, undefined, false);
      } catch {}
    },
    'tool.execute.before': async (input, output) => sendEvent(input, 'PreToolUse', directory, toolFields(input, output)),
    'tool.execute.after': async (input, output) => sendEvent(input, 'PostToolUse', directory, toolFields(input, output)),
    'permission.ask': approve,
    'permission.asked': approve,
  };
}
