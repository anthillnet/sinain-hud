import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonAdapterInternals } from './_factories.mjs';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'];
const toolMatcherEvents = ['PreToolUse', 'PostToolUse'];
const root = (home) => join(home, '.kiro');

async function agentFiles(home) {
  const agents = join(root(home), 'agents');
  try {
    return (await readdir(agents))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => join(agents, file));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function update(ctx, uninstall) {
  let files = await agentFiles(ctx.home);
  const fallback = join(root(ctx.home), 'agents', 'sinain-hooks.json');
  if (!files.length && !uninstall) files = [fallback];
  if (!files.length) return { changed: false, message: 'Removed Kiro hooks (no changes).' };

  // Parse every agent config before changing any of them.
  const configs = [];
  for (const path of files) {
    configs.push([path, await jsonAdapterInternals.readObject(ctx, path, 'Kiro agent config')]);
  }

  let changed = false;
  for (const [path, settings] of configs) {
    if (uninstall) {
      const restored = await jsonAdapterInternals.restoreBackup(ctx, path);
      if (restored) {
        changed ||= restored.changed;
        continue;
      }
    }
    const output = ctx.helpers.claudeStyleHooks(
      settings,
      events,
      (event) => `node "${ctx.bridgePath}" --source kiro --event ${event}`,
      { toolMatcherEvents, uninstall },
    );
    if (uninstall && path === fallback && !Object.keys(output).length) {
      if (!ctx.dryRun) await rm(path, { force: true });
      changed = true;
      continue;
    }
    const result = await ctx.helpers.writeConfig(
      path,
      `${JSON.stringify(output, null, 2)}\n`,
      { dryRun: ctx.dryRun },
    );
    changed ||= result.changed;
  }
  return { changed, message: `${uninstall ? 'Removed' : 'Installed'} Kiro hooks${changed ? '.' : ' (no changes).'}` };
}

export default {
  name: 'kiro',
  confidence: 'speculative',
  configPath: (home) => join(root(home), 'agents', '*.json'),
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Per-agent Kiro hook configs; convention-designed and directory-detection gated.',
};
