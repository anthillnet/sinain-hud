import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const events = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'PreCompact', 'SubagentStart', 'SubagentStop',
];
const toolMatcherEvents = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

function root(home) {
  return process.env.CODEX_HOME ?? join(home, '.codex');
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function replaceValue(content, found, value) {
  const lines = content.split(/(?<=\n)/);
  lines[found.index] = lines[found.index].replace(found.value, value);
  return lines.join('');
}

async function updateHooks(ctx, uninstall, codexRoot) {
  const hooksPath = join(codexRoot, 'hooks.json');
  const parsed = await ctx.helpers.readJsonSafe(hooksPath);
  if (!parsed.ok) throw new Error(`Cannot parse Codex hooks at ${hooksPath}; no changes were made.`);
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`Codex hooks at ${hooksPath} must contain a JSON object; no changes were made.`);
  }
  const output = ctx.helpers.claudeStyleHooks(
    parsed.data,
    events,
    (event) => `node "${ctx.bridgePath}" --source codex --event ${event}`,
    { toolMatcherEvents, uninstall },
  );
  return ctx.helpers.writeConfig(
    hooksPath,
    `${JSON.stringify(output, null, 2)}\n`,
    { dryRun: ctx.dryRun },
  );
}

async function updateNotify(ctx, uninstall, codexRoot) {
  const configPath = join(codexRoot, 'config.toml');
  const sidecarPath = join(codexRoot, 'sinain-notify-original.json');
  const chainPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'codex-notify-chain.mjs');
  const chainValue = JSON.stringify(['node', chainPath]);
  const original = await readText(configPath);
  let content = original;
  const found = ctx.helpers.tomlFindTopLevelKey(content, 'notify');

  if (uninstall) {
    let saved;
    try { saved = JSON.parse(await readFile(sidecarPath, 'utf8')); } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`Cannot read ${sidecarPath}: ${error.message}`);
    }
    if (found && found.value.includes('codex-notify-chain.mjs')) {
      if (typeof saved === 'string') content = replaceValue(content, found, saved);
      else {
        const lines = content.split(/(?<=\n)/);
        lines.splice(found.index, 1);
        content = lines.join('');
      }
    }
    content = ctx.helpers.tomlManagedBlock(content, [], { remove: true });
    const result = await ctx.helpers.writeConfig(configPath, content, { dryRun: ctx.dryRun });
    if (!ctx.dryRun) await rm(sidecarPath, { force: true });
    return result;
  }

  if (found) {
    if (found.value.includes('codex-notify-chain.mjs')) return { changed: false };
    if (!ctx.dryRun) {
      await mkdir(codexRoot, { recursive: true });
      if (!existsSync(sidecarPath)) await writeFile(sidecarPath, `${JSON.stringify(found.value, null, 2)}\n`);
    }
    content = replaceValue(content, found, chainValue);
  } else {
    content = ctx.helpers.tomlManagedBlock(content, [`notify = ${chainValue}`]);
  }
  return ctx.helpers.writeConfig(configPath, content, { dryRun: ctx.dryRun });
}

async function update(ctx, uninstall) {
  const codexRoot = root(ctx.home);
  // Validate JSON before making either config change.
  const hooksPath = join(codexRoot, 'hooks.json');
  const parsed = await ctx.helpers.readJsonSafe(hooksPath);
  if (!parsed.ok) throw new Error(`Cannot parse Codex hooks at ${hooksPath}; no changes were made.`);
  const hooks = await updateHooks(ctx, uninstall, codexRoot);
  const notify = await updateNotify(ctx, uninstall, codexRoot);
  return {
    changed: hooks.changed || notify.changed,
    message: `${uninstall ? 'Removed' : 'Installed'} Codex hooks and notify chain${hooks.changed || notify.changed ? '.' : ' (no changes).'}`,
    hint: uninstall ? undefined : 'run codex and approve the sinain-bridge hooks when prompted (or use --dangerously-bypass-hook-trust for automation)',
  };
}

export default {
  name: 'codex',
  confidence: 'verified',
  configPath: (home) => root(home),
  detect: ({ home }) => existsSync(root(home)),
  install: (ctx) => update(ctx, false),
  uninstall: (ctx) => update(ctx, true),
  notes: 'Codex hooks plus a chained turn-end notify command.',
};
