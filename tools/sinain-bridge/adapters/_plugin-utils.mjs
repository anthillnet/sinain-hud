import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_JS = '// sinain-bridge managed';
const MANAGED_YAML = '# sinain-bridge managed';
const pluginRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins');

export function firstExisting(paths, fallback = paths[0]) {
  return paths.find((path) => existsSync(path)) ?? fallback;
}

export async function installPayload(ctx, payloadName, targetPath, replacements = {}) {
  let content = await readFile(join(pluginRoot, payloadName), 'utf8');
  for (const [needle, value] of Object.entries(replacements)) {
    if (!content.includes(needle)) throw new Error(`Payload ${payloadName} is missing placeholder ${needle}`);
    content = content.replaceAll(needle, value);
  }

  let previous;
  try { previous = await readFile(targetPath, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (previous === content) return { changed: false };
  if (!ctx.dryRun) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }
  return { changed: true };
}

export async function uninstallPayload(ctx, targetPath) {
  let content;
  try { content = await readFile(targetPath, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { changed: false };
    throw error;
  }
  const header = targetPath.endsWith('.yaml') || targetPath.endsWith('.yml') ? MANAGED_YAML : MANAGED_JS;
  if (content.split(/\r?\n/, 1)[0] !== header) return { changed: false };
  if (!ctx.dryRun) await rm(targetPath);
  return { changed: true };
}

export function resultMessage(name, uninstall, changed) {
  if (!changed) return `${uninstall ? 'Removed' : 'Installed'} ${name} plugin (no changes).`;
  return `${uninstall ? 'Removed' : 'Installed'} ${name} plugin.`;
}
