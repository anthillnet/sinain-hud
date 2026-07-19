import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const events = ['session_start', 'pre_tool_use', 'post_tool_use', 'turn_end'];
const startMarker = '# >>> sinain-bridge >>>';
const endMarker = '# <<< sinain-bridge <<<';

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function commandLines(source, bridgePath) {
  const lines = [];
  for (const event of events) {
    if (lines.length) lines.push('');
    lines.push(
      '[[hooks]]',
      `event = ${JSON.stringify(event)}`,
      `command = [${['node', bridgePath, '--source', source, '--event', event].map((part) => JSON.stringify(part)).join(', ')}]`,
    );
  }
  return lines;
}

function blockBounds(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(startMarker);
  const end = start < 0 ? -1 : lines.indexOf(endMarker, start + 1);
  if ((start >= 0) !== (end >= 0)) throw new Error('Malformed sinain-bridge managed TOML block');
  return { newline, lines, start, end };
}

// tomlManagedBlock intentionally inserts a blank separator before an appended
// block. Its line-based removal retains that separator. If the one-time backup
// proves the surrounding bytes were untouched, restore those exact bytes.
async function removeBlockExactly(ctx, path, content) {
  const bounds = blockBounds(content);
  if (bounds.start < 0) return content;

  // Let the shared helper validate and remove the managed region, then remove
  // the blank separator that it added when the block was appended.
  ctx.helpers.tomlManagedBlock(content, [], { remove: true });
  const exactLines = [...bounds.lines];
  const removeStart = bounds.start > 0 && exactLines[bounds.start - 1] === ''
    ? bounds.start - 1
    : bounds.start;
  exactLines.splice(removeStart, bounds.end - removeStart + 1);
  const removed = exactLines.join(bounds.newline);
  const backup = await readText(`${path}.sinain-backup`);
  if (existsSync(`${path}.sinain-backup`)) {
    const installedFromBackup = ctx.helpers.tomlManagedBlock(backup, commandLines('', ctx.bridgePath));
    const installedBounds = blockBounds(installedFromBackup);
    const currentOutside = [...bounds.lines.slice(0, bounds.start), ...bounds.lines.slice(bounds.end + 1)].join(bounds.newline);
    const backupOutside = [
      ...installedBounds.lines.slice(0, installedBounds.start),
      ...installedBounds.lines.slice(installedBounds.end + 1),
    ].join(installedBounds.newline);
    if (currentOutside === backupOutside) return backup;
  }
  return removed;
}

export function createTomlAdapter({ name, directory, confidence, notes }) {
  const root = (home) => join(home, directory);
  const configPath = (home) => join(root(home), 'config.toml');

  async function update(ctx, uninstall) {
    const path = configPath(ctx.home);
    const original = await readText(path);
    const content = uninstall
      ? await removeBlockExactly(ctx, path, original)
      : ctx.helpers.tomlManagedBlock(original, commandLines(name, ctx.bridgePath));
    let result;
    if (!uninstall) {
      result = await ctx.helpers.writeConfig(path, content, { dryRun: ctx.dryRun });
    } else if (content === original) {
      result = { changed: false };
    } else if (ctx.dryRun) {
      result = { changed: true };
    } else {
      // Backups belong to installation. Do not create a backup of our own
      // generated block while removing it from a formerly missing config.
      await writeFile(path, content);
      result = { changed: true };
    }
    return {
      changed: result.changed,
      message: `${uninstall ? 'Removed' : 'Installed'} ${name} hooks${result.changed ? '.' : ' (no changes).'}`,
    };
  }

  return {
    name,
    confidence,
    configPath,
    detect: ({ home }) => existsSync(root(home)),
    install: (ctx) => update(ctx, false),
    uninstall: (ctx) => update(ctx, true),
    notes,
  };
}
