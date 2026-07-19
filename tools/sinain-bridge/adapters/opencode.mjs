import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installPayload, resultMessage, uninstallPayload } from './_plugin-utils.mjs';

function root(home) { return join(home, '.config', 'opencode'); }
function target(home) {
  const base = root(home);
  return join(base, existsSync(join(base, 'plugins')) ? 'plugins' : 'plugin', 'sinain-bridge.js');
}

async function update(ctx, uninstall) {
  const result = uninstall
    ? await uninstallPayload(ctx, target(ctx.home))
    : await installPayload(ctx, 'sinain-opencode.js', target(ctx.home));
  return { changed: result.changed, message: resultMessage('OpenCode', uninstall, result.changed) };
}

export default {
  name: 'opencode',
  confidence: 'doc-derived',
  configPath: target,
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'two-way approvals',
};
