#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'sinain-json-adapters-'));
const home = join(temp, 'home');
const cleanEnv = { ...process.env, SINAIN_ADAPTER_HOME: home };
delete cleanEnv.CLAUDE_SETTINGS;
delete cleanEnv.CODEX_HOME;
let failures = 0;

function check(condition, label, detail = '') {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function run(args, env = cleanEnv, input) {
  const result = spawnSync(process.execPath, args, { cwd: here, env, input, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function missing(path) {
  try { await stat(path); return false; } catch (error) { return error?.code === 'ENOENT'; }
}

const originals = {
  cursor: '{"theme":"dark","hooks":{"stop":[{"command":"original-stop"}]}}\n',
  gemini: '{\n  "theme": "gemini",\n  "hooks": {"Custom": [{"hooks": [{"type":"command","command":"keep-me"}]}]}\n}\n',
  droid: '{"model":"factory-test"}\n',
  trae: '{"telemetry":false}\n',
  kiroOne: '{"name":"one","tools":["shell"]}\n',
  kiroTwo: '{\n  "name": "two"\n}\n',
};

for (const directory of ['.cursor', '.gemini', '.factory', '.trae', '.kiro/agents']) {
  await mkdir(join(home, directory), { recursive: true });
}
await writeFile(join(home, '.cursor', 'hooks.json'), originals.cursor);
await writeFile(join(home, '.gemini', 'settings.json'), originals.gemini);
await writeFile(join(home, '.factory', 'settings.json'), originals.droid);
await writeFile(join(home, '.trae', 'hooks.json'), originals.trae);
await writeFile(join(home, '.kiro', 'agents', 'one.json'), originals.kiroOne);
await writeFile(join(home, '.kiro', 'agents', 'two.json'), originals.kiroTwo);

let result = run(['install.mjs', '--list']);
check(result.status === 0, 'JSON adapter --list exits successfully');
check(/cursor\tyes\tdoc-derived/.test(result.stdout), 'Cursor detection and confidence are listed');
check(/gemini\tyes\tdoc-derived/.test(result.stdout), 'Gemini detection and confidence are listed');
check(/zcode\tno\tspeculative/.test(result.stdout), 'Absent speculative adapter is detection-gated');

result = run(['install.mjs', '--all']);
check(result.status === 0, 'JSON adapters install under --all');
check(await missing(join(home, '.zcode', 'settings.json')), '--all does not create an undetected adapter config');

const cursor = JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'));
check(cursor.version === 1, 'Cursor writes schema version 1');
check(Object.keys(cursor.hooks).length === 5, 'Cursor installs its five supported native events');
check(cursor.hooks.stop.some((entry) => entry.command === 'original-stop'), 'Cursor preserves unrelated hook entries');
check(cursor.hooks.beforeShellExecution[0].command.endsWith('--cursor-ack'), 'Cursor shell-before hook includes acknowledgement flag');
check(cursor.hooks.beforeMCPExecution[0].command.endsWith('--cursor-ack'), 'Cursor MCP-before hook includes acknowledgement flag');
check(!cursor.hooks.afterFileEdit[0].command.includes('--cursor-ack'), 'Cursor after hook does not include acknowledgement flag');

for (const [name, path] of [
  ['Gemini', join(home, '.gemini', 'settings.json')],
  ['Droid', join(home, '.factory', 'settings.json')],
]) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  check(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification']
    .every((event) => Array.isArray(config.hooks?.[event])), `${name} installs all six supported hooks`);
}
const gemini = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'));
check(gemini.theme === 'gemini' && gemini.hooks.Custom[0].hooks[0].command === 'keep-me', 'Gemini preserves unrelated keys and hooks');
const trae = JSON.parse(await readFile(join(home, '.trae', 'hooks.json'), 'utf8'));
check(trae.version === 1 && trae.telemetry === false, 'Trae uses cursor schema and preserves unrelated keys');

for (const file of ['one.json', 'two.json']) {
  const agent = JSON.parse(await readFile(join(home, '.kiro', 'agents', file), 'utf8'));
  check(Object.keys(agent.hooks ?? {}).length === 6, `Kiro merges hooks into existing ${file}`);
}

const installedPaths = [
  join(home, '.cursor', 'hooks.json'), join(home, '.gemini', 'settings.json'),
  join(home, '.factory', 'settings.json'), join(home, '.trae', 'hooks.json'),
  join(home, '.kiro', 'agents', 'one.json'), join(home, '.kiro', 'agents', 'two.json'),
];
const snapshots = await Promise.all(installedPaths.map((path) => readFile(path, 'utf8')));
result = run(['install.mjs', '--all']);
check(result.status === 0, 'second JSON adapter install exits successfully');
const snapshotsAgain = await Promise.all(installedPaths.map((path) => readFile(path, 'utf8')));
check(snapshots.every((content, index) => content === snapshotsAgain[index]), 'second JSON adapter install is byte-identical');

result = run(['install.mjs', '--all', '--uninstall']);
check(result.status === 0, 'JSON adapters uninstall under --all');
for (const [label, path, original] of [
  ['Cursor', join(home, '.cursor', 'hooks.json'), originals.cursor],
  ['Gemini', join(home, '.gemini', 'settings.json'), originals.gemini],
  ['Droid', join(home, '.factory', 'settings.json'), originals.droid],
  ['Trae', join(home, '.trae', 'hooks.json'), originals.trae],
  ['Kiro one', join(home, '.kiro', 'agents', 'one.json'), originals.kiroOne],
  ['Kiro two', join(home, '.kiro', 'agents', 'two.json'), originals.kiroTwo],
]) {
  check(await readFile(path, 'utf8') === original, `${label} uninstall restores byte-identical original`);
}

const fallbackHome = join(temp, 'kiro-fallback');
await mkdir(join(fallbackHome, '.kiro'), { recursive: true });
const fallbackEnv = { ...cleanEnv, SINAIN_ADAPTER_HOME: fallbackHome };
result = run(['install.mjs', 'kiro'], fallbackEnv);
check(result.status === 0, 'Kiro fallback install exits successfully');
const fallbackPath = join(fallbackHome, '.kiro', 'agents', 'sinain-hooks.json');
const fallback = JSON.parse(await readFile(fallbackPath, 'utf8'));
check(Object.keys(fallback.hooks ?? {}).length === 6, 'Kiro creates hooks-only fallback when no agents exist');
result = run(['install.mjs', 'kiro', '--uninstall'], fallbackEnv);
check(result.status === 0 && await missing(fallbackPath), 'Kiro removes its hooks-only fallback on uninstall');

result = run(
  ['sinain-bridge.mjs', '--source', 'cursor', '--event', 'beforeShellExecution', '--cursor-ack'],
  { ...cleanEnv, SINAIN_PORT: '1' },
  JSON.stringify({ command: 'npm test', tool_input: { timeout: 10 } }),
);
check(result.status === 0 && result.stdout.trim() === '{"permission":"allow"}', 'Cursor bridge prints allow acknowledgement');
const bridgeSource = await readFile(join(here, 'sinain-bridge.mjs'), 'utf8');
check(/beforeShellExecution:\s*'PreToolUse'/.test(bridgeSource) && /'permission\.asked':\s*'PermissionRequest'/.test(bridgeSource), 'Bridge contains Cursor and generic event aliases');
check(/frame\.native_event_name = frame\.hook_event_name/.test(bridgeSource), 'Bridge preserves the native event name during normalization');
check(/frame\.tool_input = \{ \.\.\.toolInput, command: frame\.command \}/.test(bridgeSource), 'Bridge folds Cursor command into tool_input');

const adapterModules = [
  '_factories.mjs', 'antigravity.mjs', 'codebuddy.mjs', 'copilot.mjs', 'cursor.mjs',
  'droid.mjs', 'gajae.mjs', 'gemini.mjs', 'grok.mjs', 'kiro.mjs', 'mistralvibe.mjs',
  'qoder.mjs', 'qwen.mjs', 'trae.mjs', 'workbuddy.mjs', 'zcode.mjs',
];
for (const module of ['sinain-bridge.mjs', 'test-json-adapters.mjs', ...adapterModules.map((file) => `adapters/${file}`)]) {
  const checked = spawnSync(process.execPath, ['--check', join(here, module)], { encoding: 'utf8' });
  check(checked.status === 0, `node --check ${module}`, checked.stderr.trim());
}

if (failures) {
  console.error(`FAIL ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS all JSON adapter smoke tests');
