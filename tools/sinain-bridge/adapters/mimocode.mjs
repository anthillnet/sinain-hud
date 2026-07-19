import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installPayload, resultMessage, uninstallPayload } from './_plugin-utils.mjs';

function root(home) { return join(home, '.config', 'mimocode'); }
function target(home) { return join(root(home), 'plugin', 'sinain-bridge.js'); }

async function update(ctx, uninstall) {
  const result = uninstall
    ? await uninstallPayload(ctx, target(ctx.home))
    : await installPayload(ctx, 'sinain-opencode.js', target(ctx.home), {
      'const SOURCE = "opencode";': 'const SOURCE = "mimocode";',
    });
  return { changed: result.changed, message: resultMessage('Mimocode', uninstall, result.changed) };
}

export default {
  name: 'mimocode',
  confidence: 'speculative',
  configPath: target,
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'OpenCode-compatible plugin API.',
};
