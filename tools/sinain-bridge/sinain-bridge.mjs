#!/usr/bin/env node

import { execFile } from 'node:child_process';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

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

const input = await readInput();
const source = argValue('--source', 'claude');
const event = argValue('--event');
const frame = {
  ...input,
  source,
  hook_event_name: input.hook_event_name ?? event,
  ts: Date.now(),
};

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
}
