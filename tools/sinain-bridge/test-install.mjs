#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'sinain-adapters-'));
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

function run(args, env = cleanEnv) {
  const result = spawnSync(process.execPath, args, { cwd: here, env, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

let result = run(['install.mjs', '--list']);
check(result.status === 0, '--list exits successfully');
check(/claude\tno/.test(result.stdout) && /codex\tno/.test(result.stdout), '--list reports both adapters undetected');

const claudeDir = join(home, '.claude');
const codexDir = join(home, '.codex');
await mkdir(claudeDir, { recursive: true });
await mkdir(codexDir, { recursive: true });
await writeFile(join(claudeDir, 'settings.json'), '{"model":"opus"}\n');
const originalNotify = 'notify = ["/usr/bin/original-notifier", "turn-ended"]';
const originalToml = `model = "gpt-test"\n${originalNotify}\nsandbox_mode = "workspace-write"\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n`;
await writeFile(join(codexDir, 'config.toml'), originalToml);

result = run(['install.mjs', '--all']);
check(result.status === 0, '--all install exits successfully');
const claude = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
check(claude.model === 'opus', 'Claude preserves unrelated settings');
check(Object.keys(claude.hooks ?? {}).length === 8, 'Claude installs all hooks');
const codexHooks = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
check(Object.keys(codexHooks.hooks ?? {}).length === 7, 'Codex hooks.json has seven events');
const installedToml = await readFile(join(codexDir, 'config.toml'), 'utf8');
check(/notify = \["node",".*codex-notify-chain\.mjs"\]/.test(installedToml), 'Codex notify is chained');
const sidecar = JSON.parse(await readFile(join(codexDir, 'sinain-notify-original.json'), 'utf8'));
check(sidecar === '["/usr/bin/original-notifier", "turn-ended"]', 'Codex original notify is saved exactly');
check(installedToml.replace(/^notify = .*$/m, originalNotify) === originalToml, 'Unrelated TOML bytes are unchanged');

const snapshots = await Promise.all([
  readFile(join(claudeDir, 'settings.json'), 'utf8'),
  readFile(join(codexDir, 'hooks.json'), 'utf8'),
  readFile(join(codexDir, 'config.toml'), 'utf8'),
  readFile(join(codexDir, 'sinain-notify-original.json'), 'utf8'),
]);
result = run(['install.mjs', '--all']);
check(result.status === 0, 'second --all exits successfully');
const snapshotsAgain = await Promise.all([
  readFile(join(claudeDir, 'settings.json'), 'utf8'),
  readFile(join(codexDir, 'hooks.json'), 'utf8'),
  readFile(join(codexDir, 'config.toml'), 'utf8'),
  readFile(join(codexDir, 'sinain-notify-original.json'), 'utf8'),
]);
check(snapshots.every((value, index) => value === snapshotsAgain[index]), 'second install is byte-identical');

result = run(['install.mjs', '--all', '--uninstall']);
check(result.status === 0, '--all uninstall exits successfully');
const uninstalledClaude = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
check(uninstalledClaude.model === 'opus' && !uninstalledClaude.hooks, 'Claude managed hooks are removed');
const uninstalledCodex = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
check(!uninstalledCodex.hooks, 'Codex managed hooks are removed');
check(await readFile(join(codexDir, 'config.toml'), 'utf8') === originalToml, 'Codex notify and TOML restore byte-identically');
let sidecarGone = false;
try { await stat(join(codexDir, 'sinain-notify-original.json')); } catch (error) { sidecarGone = error?.code === 'ENOENT'; }
check(sidecarGone, 'Codex notify sidecar is removed');

const secondHome = join(temp, 'shim');
const shimSettings = join(secondHome, 'settings.json');
result = run(['install-claude.mjs'], { ...process.env, CLAUDE_SETTINGS: shimSettings, SINAIN_ADAPTER_HOME: secondHome });
check(result.status === 0, 'legacy Claude shim exits successfully');
const shim = JSON.parse(await readFile(shimSettings, 'utf8'));
check(Object.keys(shim.hooks ?? {}).length === 8, 'legacy Claude shim installs hooks');

const modules = ['lib.mjs', 'install.mjs', 'install-claude.mjs', 'codex-notify-chain.mjs', 'test-install.mjs', 'adapters/claude.mjs', 'adapters/codex.mjs'];
for (const module of modules) {
  const checked = spawnSync(process.execPath, ['--check', join(here, module)], { encoding: 'utf8' });
  check(checked.status === 0, `node --check ${module}`, checked.stderr.trim());
}

if (failures) {
  console.error(`FAIL ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS all smoke tests');
