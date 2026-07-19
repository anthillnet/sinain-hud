import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SessionEnd', 'PermissionRequest',
];
const toolMatcherEvents = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

function settingsPath(home) {
  return process.env.CLAUDE_SETTINGS ?? join(home, '.claude', 'settings.json');
}

async function update(ctx, uninstall) {
  const path = settingsPath(ctx.home);
  const parsed = await ctx.helpers.readJsonSafe(path);
  if (!parsed.ok) throw new Error(`Cannot parse Claude settings at ${path}; no changes were made.`);
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`Claude settings at ${path} must contain a JSON object; no changes were made.`);
  }
  const output = ctx.helpers.claudeStyleHooks(
    parsed.data,
    events,
    (event) => `node "${ctx.bridgePath}" --source claude --event ${event}`,
    { toolMatcherEvents, uninstall },
  );
  let original = '{}\n';
  try { original = await readFile(path, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const content = `${JSON.stringify(output, null, 2)}\n`;
  const result = await ctx.helpers.writeConfig(path, content, { dryRun: ctx.dryRun });
  return { changed: result.changed, message: `${uninstall ? 'Removed' : 'Installed'} Claude hooks${content === original ? ' (no changes)' : ''}.` };
}

export default {
  name: 'claude',
  confidence: 'verified',
  configPath: (home) => process.env.CLAUDE_SETTINGS ?? join(home, '.claude'),
  detect: ({ home }) => existsSync(process.env.CLAUDE_SETTINGS ?? join(home, '.claude')),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Claude Code lifecycle hooks.',
};
