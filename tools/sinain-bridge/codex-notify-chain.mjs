#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appendedArgs = process.argv.slice(2);
let notification = {};
for (const arg of appendedArgs) {
  try {
    const parsed = JSON.parse(arg);
    if (parsed && typeof parsed === 'object') notification = parsed;
  } catch { /* Codex may append non-JSON arguments. */ }
}
const sessionId = notification.session_id ?? notification.thread_id ?? notification['thread-id']
  ?? `codex-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}`;
const message = notification.message ?? notification.last_assistant_message
  ?? notification['last-assistant-message'] ?? notification.text;
const frame = { session_id: String(sessionId), hook_event_name: 'Stop' };
if (message != null) frame.message = String(message);

try {
  const bridgePath = join(dirname(fileURLToPath(import.meta.url)), 'sinain-bridge.mjs');
  const bridge = spawn(process.execPath, [bridgePath, '--source', 'codex', '--event', 'Stop'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  bridge.on('error', () => {});
  bridge.stdin.on('error', () => {});
  bridge.stdin.end(JSON.stringify(frame));
  const timer = setTimeout(() => bridge.kill(), 1500);
  timer.unref();
  bridge.unref();
} catch { /* The user's notifier must run even if forwarding fails. */ }

const codexRoot = process.env.CODEX_HOME ?? join(homedir(), '.codex');
let original;
try {
  original = JSON.parse(await readFile(join(codexRoot, 'sinain-notify-original.json'), 'utf8'));
} catch { process.exit(0); }

if (typeof original === 'string') {
  try { original = JSON.parse(original); } catch { process.exit(0); }
}

if (!Array.isArray(original) || !original.length || original.some((part) => typeof part !== 'string')) {
  process.exit(0);
}
const child = spawn(original[0], [...original.slice(1), ...appendedArgs], { stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
