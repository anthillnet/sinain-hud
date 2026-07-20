#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const terminalNames = [
  'ITERM_SESSION_ID', 'TMUX', 'TMUX_PANE', 'KITTY_WINDOW_ID',
  'WEZTERM_PANE', 'TERM_SESSION_ID', '__CFBundleIdentifier',
];
const cleanEnv = {
  ...process.env,
  NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'test-fetch-capture.mjs')).href}`,
  SINAIN_ENRICH_FACTS: '0',
};
for (const name of terminalNames) delete cleanEnv[name];

function postedFrame(env) {
  const result = spawnSync(
    process.execPath,
    [join(here, 'sinain-bridge.mjs'), '--source', 'claude', '--event', 'PreToolUse'],
    { env, input: JSON.stringify({ session_id: 'term-capture-test' }), encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || `bridge exited ${result.status}`);
  return JSON.parse(result.stdout);
}

const withTerm = postedFrame({ ...cleanEnv, ITERM_SESSION_ID: 'test-terminal-id' });
const withoutTerm = postedFrame(cleanEnv);

if (withTerm.term?.ITERM_SESSION_ID !== 'test-terminal-id') {
  throw new Error('PreToolUse frame did not capture ITERM_SESSION_ID');
}
if (Object.hasOwn(withoutTerm, 'term')) {
  throw new Error('frame without terminal env unexpectedly included term');
}

console.log('PASS terminal env capture');
