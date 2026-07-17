#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'sinain-plugin-adapters-'));
const home = join(temp, 'home');
const env = { ...process.env, SINAIN_ADAPTER_HOME: home };
let failures = 0;

function check(condition, label, detail = '') {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: here, env, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

let result = run(['install.mjs', '--list']);
check(result.status === 0, '--list exits successfully');
for (const name of ['amp', 'hermes', 'mimocode', 'opencode', 'pi']) {
  check(new RegExp(`^${name}\\tno\\t`, 'm').test(result.stdout), `${name} is gated when its config root is absent`);
}

const opencodeRoot = join(home, '.config', 'opencode');
const mimocodeRoot = join(home, '.config', 'mimocode');
const ampRoot = join(home, '.config', 'amp');
const hermesRoot = join(home, '.hermes');
const piRoot = join(home, '.config', 'pi');
await mkdir(join(opencodeRoot, 'plugins'), { recursive: true });
await mkdir(mimocodeRoot, { recursive: true });
await mkdir(join(ampRoot, 'plugins'), { recursive: true });
await mkdir(hermesRoot, { recursive: true });
await mkdir(piRoot, { recursive: true });

const userPlugin = join(ampRoot, 'plugins', 'user-plugin.js');
const userContent = '// user owned\nexport default {};\n';
await writeFile(userPlugin, userContent);

result = run(['install.mjs', '--list']);
for (const name of ['amp', 'hermes', 'mimocode', 'opencode', 'pi']) {
  check(new RegExp(`^${name}\\tyes\\t`, 'm').test(result.stdout), `${name} is detected when its config root exists`);
}

result = run(['install.mjs', '--all']);
check(result.status === 0, '--all plugin install exits successfully');

const targets = {
  opencode: join(opencodeRoot, 'plugins', 'sinain-bridge.js'),
  mimocode: join(mimocodeRoot, 'plugin', 'sinain-bridge.js'),
  amp: join(ampRoot, 'plugins', 'sinain-bridge.js'),
  hermes: join(hermesRoot, 'plugins', 'sinain-bridge.yaml'),
  pi: join(piRoot, 'extensions', 'sinain-bridge.js'),
};
const installed = Object.fromEntries(await Promise.all(
  Object.entries(targets).map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
));

check(installed.opencode.startsWith('// sinain-bridge managed\n'), 'OpenCode payload has managed header');
check(installed.opencode.includes('const SOURCE = "opencode";'), 'OpenCode SOURCE is correct');
check(installed.mimocode.includes('const SOURCE = "mimocode";'), 'Mimocode SOURCE is rewritten');
check(!installed.mimocode.includes('const SOURCE = "opencode";'), 'Mimocode payload does not retain OpenCode SOURCE');
check(installed.amp.startsWith('// sinain-bridge managed\n'), 'Amp payload has managed header');
check(installed.pi.startsWith('// sinain-bridge managed\n'), 'Pi payload has managed header');
check(installed.hermes.startsWith('# sinain-bridge managed\n') && installed.hermes.trim().length > 0, 'Hermes YAML is non-empty and managed');
check(installed.hermes.includes(join(here, 'sinain-bridge.mjs')), 'Hermes YAML contains the absolute bridge path');
check(targets.pi.startsWith(join(home, '.config', 'pi')), 'Pi selects the existing ~/.config/pi root');

for (const [name, path] of Object.entries(targets)) {
  if (!path.endsWith('.js')) continue;
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  check(checked.status === 0, `node --check installed ${name} payload`, checked.stderr.trim());
}

result = run(['install.mjs', '--all']);
check(result.status === 0, 'second --all plugin install exits successfully');
const installedAgain = Object.fromEntries(await Promise.all(
  Object.entries(targets).map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
));
check(Object.keys(installed).every((name) => installed[name] === installedAgain[name]), 'plugin reinstall is byte-identical');

result = run(['install.mjs', '--all', '--uninstall']);
check(result.status === 0, '--all plugin uninstall exits successfully');
for (const [name, path] of Object.entries(targets)) {
  check(!(await exists(path)), `${name} managed payload is deleted`);
}
check(await readFile(userPlugin, 'utf8') === userContent, 'unmanaged user plugin alongside managed payload survives');

const unmanagedTarget = targets.amp;
await writeFile(unmanagedTarget, userContent);
result = run(['install.mjs', 'amp', '--uninstall']);
check(result.status === 0, 'uninstall with an unmanaged target exits successfully');
check(await readFile(unmanagedTarget, 'utf8') === userContent, 'uninstall does not delete an unmanaged target file');

const modules = [
  'adapters/_plugin-utils.mjs', 'adapters/amp.mjs', 'adapters/hermes.mjs',
  'adapters/mimocode.mjs', 'adapters/opencode.mjs', 'adapters/pi.mjs',
  'test-plugin-adapters.mjs',
];
for (const module of modules) {
  const checked = spawnSync(process.execPath, ['--check', join(here, module)], { encoding: 'utf8' });
  check(checked.status === 0, `node --check ${module}`, checked.stderr.trim());
}

if (failures) {
  console.error(`FAIL ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS all plugin adapter tests');
