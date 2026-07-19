#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helpers } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.SINAIN_ADAPTER_HOME ?? homedir();
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const names = args.filter((arg) => !arg.startsWith('--'));
const allowed = new Set(['--all', '--uninstall', '--dry-run', '--list']);
const invalid = [...flags].filter((flag) => !allowed.has(flag));

if (invalid.length || (flags.has('--all') && names.length)) {
  console.error(invalid.length ? `Unknown option(s): ${invalid.join(', ')}` : 'Do not combine --all with adapter names.');
  process.exit(2);
}

const files = (await readdir(join(here, 'adapters'))).filter((file) => file.endsWith('.mjs') && !file.startsWith('_')).sort();
const adapters = [];
for (const file of files) {
  const { default: adapter } = await import(pathToFileURL(join(here, 'adapters', file)));
  adapters.push(adapter);
}
const byName = new Map(adapters.map((adapter) => [adapter.name, adapter]));

function detected(adapter) {
  try { return Boolean(adapter.detect({ home, env: process.env })); } catch { return false; }
}

if (flags.has('--list')) {
  const rows = adapters.map((adapter) => ({
    name: adapter.name,
    detected: detected(adapter) ? 'yes' : 'no',
    confidence: adapter.confidence,
    path: adapter.configPath(home),
    notes: adapter.notes,
  }));
  console.log(['NAME', 'DETECTED', 'CONFIDENCE', 'CONFIG PATH', 'NOTES'].join('\t'));
  for (const row of rows) console.log([row.name, row.detected, row.confidence, row.path, row.notes].join('\t'));
  if (!flags.has('--all') && !names.length) process.exit(0);
}

let requested;
if (flags.has('--all')) requested = adapters.filter(detected);
else {
  requested = [];
  for (const name of names) {
    const adapter = byName.get(name);
    if (!adapter) {
      console.error(`Unknown adapter: ${name}`);
      process.exitCode = 1;
    } else requested.push(adapter);
  }
}

if (!requested.length) {
  if (!flags.has('--list')) console.error('Usage: node install.mjs <agent> [<agent>...] | --all [--uninstall] [--dry-run] [--list]');
  if (!flags.has('--all') && !flags.has('--list')) process.exitCode = 2;
} else {
  const failures = [];
  for (const adapter of requested) {
    const ctx = {
      home,
      bridgePath: join(here, 'sinain-bridge.mjs'),
      dryRun: flags.has('--dry-run'),
      log: (...parts) => console.log(`[${adapter.name}]`, ...parts),
      helpers,
    };
    try {
      const result = await adapter[flags.has('--uninstall') ? 'uninstall' : 'install'](ctx);
      console.log(`[${adapter.name}] ${flags.has('--dry-run') ? 'Dry run: ' : ''}${result.message}`);
      if (result.hint) console.log(`[${adapter.name}] Hint: ${result.hint}`);
    } catch (error) {
      failures.push(adapter.name);
      console.error(`[${adapter.name}] FAILED: ${error.message}`);
    }
  }
  console.log(`Summary: ${requested.length - failures.length} succeeded, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
}
