#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'sinain-toml-adapters-'));
let failures = 0;

function check(condition, label, detail = '') {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function run(args, home) {
  const result = spawnSync(process.execPath, args, {
    cwd: here,
    env: { ...process.env, SINAIN_ADAPTER_HOME: home },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

const kimiHome = join(temp, 'kimi-home');
const kimiDir = join(kimiHome, '.kimi');
const kimiPath = join(kimiDir, 'config.toml');
await mkdir(kimiDir, { recursive: true });
const originalKimi = 'model = "moonshot-v1"\n\n[unrelated]\nvalue = "below hook settings"\n';
await writeFile(kimiPath, originalKimi);

let result = run(['install.mjs', 'kimi'], kimiHome);
check(result.status === 0, 'Kimi install exits successfully');
const installedKimi = await readFile(kimiPath, 'utf8');
check(installedKimi.startsWith(originalKimi), 'Kimi preserves all unrelated TOML bytes');
check((installedKimi.match(/\[\[hooks\]\]/g) ?? []).length === 4, 'Kimi installs four hook tables');
for (const event of ['session_start', 'pre_tool_use', 'post_tool_use', 'turn_end']) {
  check(installedKimi.includes(`event = "${event}"`), `Kimi installs ${event}`);
  check(installedKimi.includes(`"--source", "kimi", "--event", "${event}"`), `Kimi command identifies ${event}`);
}
const backup = await readFile(`${kimiPath}.sinain-backup`, 'utf8');
check(backup === originalKimi, 'Kimi creates an exact one-time backup');

result = run(['install.mjs', 'kimi'], kimiHome);
check(result.status === 0, 'Kimi reinstall exits successfully');
check(await readFile(kimiPath, 'utf8') === installedKimi, 'Kimi reinstall is byte-identical');

result = run(['install.mjs', 'kimi', '--uninstall'], kimiHome);
check(result.status === 0, 'Kimi uninstall exits successfully');
check(await readFile(kimiPath, 'utf8') === originalKimi, 'Kimi uninstall restores the original file byte-identically');
check(await readFile(`${kimiPath}.sinain-backup`, 'utf8') === originalKimi, 'Kimi backup is not overwritten');

const deepseekHome = join(temp, 'deepseek-home');
await mkdir(join(deepseekHome, '.deepseek'), { recursive: true });
result = run(['install.mjs', 'deepseek'], deepseekHome);
check(result.status === 0, 'DeepSeek fresh-file install exits successfully');
const deepseekPath = join(deepseekHome, '.deepseek', 'config.toml');
const deepseek = await readFile(deepseekPath, 'utf8');
check(deepseek.startsWith('# >>> sinain-bridge >>>\n'), 'DeepSeek fresh file contains only the managed block');
check(deepseek.endsWith('# <<< sinain-bridge <<<\n'), 'DeepSeek managed block is complete');
check((deepseek.match(/\[\[hooks\]\]/g) ?? []).length === 4, 'DeepSeek installs four hook tables');
let deepseekBackupMissing = false;
try { await stat(`${deepseekPath}.sinain-backup`); } catch (error) { deepseekBackupMissing = error?.code === 'ENOENT'; }
check(deepseekBackupMissing, 'DeepSeek does not back up a newly-created file');
result = run(['install.mjs', 'deepseek', '--uninstall'], deepseekHome);
check(result.status === 0, 'DeepSeek fresh-file uninstall exits successfully');
check(await readFile(deepseekPath, 'utf8') === '', 'DeepSeek uninstall removes exactly the managed block');
try { await stat(`${deepseekPath}.sinain-backup`); deepseekBackupMissing = false; } catch (error) { deepseekBackupMissing = error?.code === 'ENOENT'; }
check(deepseekBackupMissing, 'DeepSeek uninstall does not back up generated content');

const kimicodeHome = join(temp, 'kimicode-home');
result = run(['install.mjs', '--list'], kimicodeHome);
check(result.status === 0, 'KimiCode detection list exits successfully');
check(/^kimicode\tno\tspeculative\t/m.test(result.stdout), 'KimiCode is gated off when its directory is absent');
await mkdir(join(kimicodeHome, '.kimicode'), { recursive: true });
result = run(['install.mjs', '--list'], kimicodeHome);
check(/^kimicode\tyes\tspeculative\t/m.test(result.stdout), 'KimiCode is detected when its directory exists');
result = run(['install.mjs', '--all'], kimicodeHome);
check(result.status === 0, 'Detected KimiCode installs through --all');
check((await readFile(join(kimicodeHome, '.kimicode', 'config.toml'), 'utf8')).includes('"--source", "kimicode"'), 'KimiCode uses its own source name');

const modules = [
  'adapters/_toml-utils.mjs', 'adapters/kimi.mjs', 'adapters/kimicode.mjs',
  'adapters/deepseek.mjs', 'test-toml-adapters.mjs',
];
for (const module of modules) {
  const checked = spawnSync(process.execPath, ['--check', join(here, module)], { encoding: 'utf8' });
  check(checked.status === 0, `node --check ${module}`, checked.stderr.trim());
}

if (failures) {
  console.error(`FAIL ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS all TOML adapter tests');
