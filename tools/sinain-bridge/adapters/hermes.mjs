import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installPayload, resultMessage, uninstallPayload } from './_plugin-utils.mjs';

function root(home) { return join(home, '.hermes'); }
function target(home) { return join(root(home), 'plugins', 'sinain-bridge.yaml'); }

async function update(ctx, uninstall) {
  const result = uninstall
    ? await uninstallPayload(ctx, target(ctx.home))
    : await installPayload(ctx, 'sinain-hermes.yaml', target(ctx.home), {
      __SINAIN_BRIDGE_PATH__: JSON.stringify(ctx.bridgePath).slice(1, -1),
    });
  return { changed: result.changed, message: resultMessage('Hermes', uninstall, result.changed) };
}

export default {
  name: 'hermes',
  confidence: 'speculative',
  configPath: target,
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Command-based YAML lifecycle hooks.',
};
