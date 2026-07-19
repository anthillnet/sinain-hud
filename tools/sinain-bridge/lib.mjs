import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonSafe(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return { ok: true, data };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: {} };
    return { ok: false, error };
  }
}

export async function writeConfig(path, content, { dryRun = false } = {}) {
  let previous;
  let existed = true;
  try {
    previous = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    existed = false;
  }

  if (previous === content) return { changed: false };
  if (dryRun) return { changed: true };

  await mkdir(dirname(path), { recursive: true });
  const backupPath = `${path}.sinain-backup`;
  if (existed && !existsSync(backupPath)) await writeFile(backupPath, previous);
  await writeFile(path, content);
  return { changed: true };
}

export function claudeStyleHooks(
  settings,
  events,
  buildCommand,
  { toolMatcherEvents = [], hooksKey = 'hooks', uninstall = false } = {},
) {
  const result = structuredClone(settings);
  const toolEvents = new Set(toolMatcherEvents);
  const hooks = result[hooksKey];

  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      const keptEntries = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
          keptEntries.push(entry);
          continue;
        }
        const keptHooks = entry.hooks.filter(
          (hook) => !(typeof hook?.command === 'string' && hook.command.includes('sinain-bridge')),
        );
        if (keptHooks.length) keptEntries.push({ ...entry, hooks: keptHooks });
      }
      if (keptEntries.length) hooks[event] = keptEntries;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete result[hooksKey];
  }

  if (!uninstall) {
    result[hooksKey] ??= {};
    for (const event of events) {
      const entry = { hooks: [{ type: 'command', command: buildCommand(event) }] };
      if (toolEvents.has(event)) entry.matcher = '*';
      result[hooksKey][event] ??= [];
      result[hooksKey][event].push(entry);
    }
  }
  return result;
}

const TOML_START = '# >>> sinain-bridge >>>';
const TOML_END = '# <<< sinain-bridge <<<';

export function tomlManagedBlock(content, blockLines, { remove = false } = {}) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(TOML_START);
  const end = start >= 0 ? lines.indexOf(TOML_END, start + 1) : -1;
  if ((start >= 0) !== (end >= 0)) {
    throw new Error('Malformed sinain-bridge managed TOML block');
  }
  if (start >= 0) {
    lines.splice(start, end - start + 1, ...(remove ? [] : [TOML_START, ...blockLines, TOML_END]));
    return lines.join(newline);
  }
  if (remove) return content;

  let base = content;
  if (base && !base.endsWith('\n')) base += newline;
  return `${base}${base ? newline : ''}${TOML_START}${newline}${blockLines.join(newline)}${newline}${TOML_END}${newline}`;
}

export function tomlFindTopLevelKey(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = content.split(/\r?\n/);
  let inTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^\[/.test(trimmed)) inTable = true;
    if (inTable || !trimmed || trimmed.startsWith('#')) continue;
    const match = lines[index].match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\\[[^\\n]*\\])\\s*(?:#.*)?$`));
    if (match) return { index, value: match[1] };
  }
  return null;
}

export const helpers = {
  readJsonSafe,
  writeConfig,
  claudeStyleHooks,
  tomlManagedBlock,
  tomlFindTopLevelKey,
};
