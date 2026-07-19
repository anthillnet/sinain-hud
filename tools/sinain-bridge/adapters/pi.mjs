import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { firstExisting, installPayload, resultMessage, uninstallPayload } from './_plugin-utils.mjs';

function roots(home) { return [join(home, '.pi'), join(home, '.config', 'pi')]; }
function root(home) { return firstExisting(roots(home)); }
function target(home) { return join(root(home), 'extensions', 'sinain-bridge.js'); }

async function update(ctx, uninstall) {
  const result = uninstall
    ? await uninstallPayload(ctx, target(ctx.home))
    : await installPayload(ctx, 'sinain-pi.js', target(ctx.home));
  return { changed: result.changed, message: resultMessage('Pi', uninstall, result.changed) };
}

export default {
  name: 'pi',
  confidence: 'speculative',
  configPath: target,
  detect: ({ home }) => roots(home).some(existsSync),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Pi / Oh-My-Pi monitor-only extension.',
};
