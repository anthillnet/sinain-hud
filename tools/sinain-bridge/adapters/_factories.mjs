import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

function resolve(value, home) {
  return typeof value === 'function' ? value(home) : join(home, value);
}

async function readObject(ctx, path, label) {
  const parsed = await ctx.helpers.readJsonSafe(path);
  if (!parsed.ok) throw new Error(`Cannot parse ${label} at ${path}; no changes were made.`);
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`${label} at ${path} must contain a JSON object; no changes were made.`);
  }
  return parsed.data;
}

async function restoreBackup(ctx, path) {
  const backupPath = `${path}.sinain-backup`;
  let original;
  try {
    original = await readFile(backupPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const result = await ctx.helpers.writeConfig(path, original, { dryRun: ctx.dryRun });
  if (!ctx.dryRun) await rm(backupPath, { force: true });
  return result;
}

function cursorStyleHooks(settings, events, buildCommand, { uninstall = false } = {}) {
  const result = structuredClone(settings);
  if (result.hooks && typeof result.hooks === 'object' && !Array.isArray(result.hooks)) {
    for (const [event, entries] of Object.entries(result.hooks)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(
        (entry) => !(typeof entry?.command === 'string' && entry.command.includes('sinain-bridge')),
      );
      if (kept.length) result.hooks[event] = kept;
      else delete result.hooks[event];
    }
    if (!Object.keys(result.hooks).length) delete result.hooks;
  }
  if (!uninstall) {
    result.version = 1;
    result.hooks ??= {};
    for (const event of events) {
      result.hooks[event] ??= [];
      result.hooks[event].push({ command: buildCommand(event) });
    }
  }
  return result;
}

function makeJsonAdapter({
  name, dir, file = 'settings.json', events, confidence, notes, style,
  toolMatcherEvents = ['PreToolUse', 'PostToolUse'], cursorAckEvents = [],
}) {
  const adapterRoot = (home) => resolve(dir, home);
  const pathFor = (home) => join(adapterRoot(home), file);

  async function update(ctx, uninstall) {
    const path = pathFor(ctx.home);
    if (uninstall) {
      const restored = await restoreBackup(ctx, path);
      if (restored) {
        return { changed: restored.changed, message: `Removed ${name} hooks and restored the original config.` };
      }
    }

    const settings = await readObject(ctx, path, `${name} config`);
    const command = (event) => {
      const ack = cursorAckEvents.includes(event) ? ' --cursor-ack' : '';
      return `node "${ctx.bridgePath}" --source ${name} --event ${event}${ack}`;
    };
    const output = style === 'cursor'
      ? cursorStyleHooks(settings, events, command, { uninstall })
      : ctx.helpers.claudeStyleHooks(settings, events, command, { toolMatcherEvents, uninstall });
    const result = await ctx.helpers.writeConfig(
      path,
      `${JSON.stringify(output, null, 2)}\n`,
      { dryRun: ctx.dryRun },
    );
    return {
      changed: result.changed,
      message: `${uninstall ? 'Removed' : 'Installed'} ${name} hooks${result.changed ? '.' : ' (no changes).'}`,
    };
  }

  return {
    name,
    confidence,
    configPath: pathFor,
    detect: ({ home }) => existsSync(adapterRoot(home)),
    install: (ctx) => update(ctx, false),
    uninstall: (ctx) => update(ctx, true),
    notes,
  };
}

export function makeClaudeStyleAdapter(options) {
  return makeJsonAdapter({ ...options, style: 'claude' });
}

export function makeCursorStyleAdapter(options) {
  return makeJsonAdapter({ ...options, file: options.file ?? 'hooks.json', style: 'cursor' });
}

export const jsonAdapterInternals = { cursorStyleHooks, readObject, restoreBackup };
