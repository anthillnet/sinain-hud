#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SessionEnd', 'PermissionRequest',
];
const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const managedMarker = 'sinain-bridge.mjs';
const uninstall = process.argv.includes('--uninstall');
const dryRun = process.argv.includes('--dry-run');
const settingsPath = process.env.CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const backupPath = `${settingsPath}.sinain-backup`;
const bridgePath = join(dirname(fileURLToPath(import.meta.url)), managedMarker);

let originalText;
let settings;
try {
  originalText = await readFile(settingsPath, 'utf8');
  settings = JSON.parse(originalText);
} catch (error) {
  if (error.code === 'ENOENT') {
    originalText = '{}\n';
    settings = {};
  } else if (error instanceof SyntaxError) {
    console.error(`Cannot parse Claude settings at ${settingsPath}; no changes were made.`);
    process.exit(1);
  } else {
    console.error(`Cannot read Claude settings at ${settingsPath}: ${error.message}`);
    process.exit(1);
  }
}

if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  console.error(`Claude settings at ${settingsPath} must contain a JSON object; no changes were made.`);
  process.exit(1);
}

let removed = 0;
if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    const keptEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        keptEntries.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter((hook) => {
        const managed = typeof hook?.command === 'string' && hook.command.includes(managedMarker);
        if (managed) removed += 1;
        return !managed;
      });
      if (hooks.length) keptEntries.push({ ...entry, hooks });
    }
    if (keptEntries.length) settings.hooks[event] = keptEntries;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

let added = 0;
if (!uninstall) {
  settings.hooks ??= {};
  for (const event of events) {
    const command = `node "${bridgePath}" --source claude --event ${event}`;
    const entry = { hooks: [{ type: 'command', command }] };
    if (toolEvents.has(event)) entry.matcher = '*';
    settings.hooks[event] ??= [];
    settings.hooks[event].push(entry);
    added += 1;
  }
}

const output = `${JSON.stringify(settings, null, 2)}\n`;
const changed = output !== originalText;
if (!dryRun && changed) {
  await mkdir(dirname(settingsPath), { recursive: true });
  if (!existsSync(backupPath)) await writeFile(backupPath, originalText);
  await writeFile(settingsPath, output);
}

const prefix = dryRun ? 'Dry run: would add' : uninstall ? 'Uninstalled:' : 'Installed:';
console.log(`${prefix} ${added} hook(s), remove ${removed} managed hook(s); ${changed ? 'settings changed' : 'no changes'}.`);
if (dryRun) console.log(`No files written (${settingsPath}).`);
