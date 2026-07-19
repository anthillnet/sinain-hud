import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installPayload, resultMessage, uninstallPayload } from './_plugin-utils.mjs';

function root(home) { return join(home, '.config', 'amp'); }
function target(home) { return join(root(home), 'plugins', 'sinain-bridge.js'); }

async function update(ctx, uninstall) {
  const result = uninstall
    ? await uninstallPayload(ctx, target(ctx.home))
    : await installPayload(ctx, 'sinain-amp.js', target(ctx.home));
  return { changed: result.changed, message: resultMessage('Amp', uninstall, result.changed) };
}

export default {
  name: 'amp',
  confidence: 'speculative',
  configPath: target,
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Experimental monitor-only JavaScript plugin.',
};
