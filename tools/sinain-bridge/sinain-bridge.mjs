#!/usr/bin/env node

import { execFile } from 'node:child_process';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const EVENT_ALIASES = new Map(Object.entries({
  beforeShellExecution: 'PreToolUse',
  beforeMCPExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  afterShellExecution: 'PostToolUse',
  afterFileEdit: 'PostToolUse',
  stop: 'Stop',
  sessionStart: 'SessionStart',
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  pre_tool_call: 'PreToolUse',
  pre_tool_use: 'PreToolUse',
  post_tool_call: 'PostToolUse',
  post_tool_use: 'PostToolUse',
  user_prompt_submit: 'UserPromptSubmit',
  turn_end: 'Stop',
  'turn-ended': 'Stop',
  turn_ended: 'Stop',
  notification: 'Notification',
  permission_request: 'PermissionRequest',
  'permission.asked': 'PermissionRequest',
}));

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function currentBranch(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'branch', '--show-current'],
      { timeout: 300, encoding: 'utf8' },
      (error, stdout) => resolve(error ? '' : stdout.trim()),
    );
  });
}

async function post(url, frame, timeout, readJson = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
      signal: controller.signal,
    });
    const body = readJson ? await response.json() : undefined;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { response, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

const input = await readInput();
const source = argValue('--source', 'claude');
const event = argValue('--event');
const frame = {
  ...input,
  source,
  hook_event_name: input.hook_event_name ?? event,
  ts: Date.now(),
};
const normalizedEvent = EVENT_ALIASES.get(frame.hook_event_name);
if (normalizedEvent && normalizedEvent !== frame.hook_event_name) {
  frame.native_event_name = frame.hook_event_name;
  frame.hook_event_name = normalizedEvent;
}
if (source === 'cursor' && Object.hasOwn(frame, 'command')) {
  const toolInput = frame.tool_input && typeof frame.tool_input === 'object' && !Array.isArray(frame.tool_input)
    ? frame.tool_input : {};
  frame.tool_input = { ...toolInput, command: frame.command };
  delete frame.command;
}

if (frame.hook_event_name === 'SessionStart') {
  const names = [
    'ITERM_SESSION_ID', 'TMUX', 'TMUX_PANE', 'KITTY_WINDOW_ID',
    'WEZTERM_PANE', 'TERM_SESSION_ID', '__CFBundleIdentifier',
  ];
  frame.term = Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
  try {
    const branch = await currentBranch(
      typeof frame.cwd === 'string' ? frame.cwd : process.cwd(),
    );
    if (branch) frame.branch = branch;
  } catch {
    // Session metadata is best-effort.
  }
}

const host = process.env.SINAIN_HOST ?? '127.0.0.1';
const port = process.env.SINAIN_PORT ?? '9500';
const baseUrl = `http://${host}:${port}`;

if (frame.hook_event_name === 'PermissionRequest') {
  let behavior = 'ask';
  try {
    const { response, body } = await post(`${baseUrl}/agent/approve`, frame, 130_000, true);
    if (response.ok) {
      if (['allow', 'deny', 'always', 'ask'].includes(body?.behavior)) {
        behavior = body.behavior;
      }
    }
  } catch {
    // Asking Claude itself is the safe fallback when the hub is unavailable.
  }

  if (behavior === 'ask') {
    console.log(JSON.stringify({ decision: 'ask' }));
  } else {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior },
      },
    }));
  }
} else {
  try {
    await post(`${baseUrl}/agent/event`, frame, 1500);
  } catch {
    // Lifecycle hooks must never disrupt the agent.
  }
  if (frame.hook_event_name === 'SessionStart' && ['claude', 'codex'].includes(source) && process.env.SINAIN_ENRICH !== '0') {
    try {
      const params = new URLSearchParams({
        session_id: String(frame.session_id ?? ''),
        cwd: typeof frame.cwd === 'string' ? frame.cwd : process.cwd(),
      });
      const { response, body } = await get(`${baseUrl}/agent/enrich?${params}`, 8000);
      if (response.ok && typeof body?.brief === 'string' && body.brief) {
        console.log(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body.brief },
        }));
      }
    } catch {
      // Enrichment is best-effort and must not disrupt session startup.
    }
  }
  if (process.argv.includes('--cursor-ack')) {
    console.log(JSON.stringify({ permission: 'allow' }));
  }
}
