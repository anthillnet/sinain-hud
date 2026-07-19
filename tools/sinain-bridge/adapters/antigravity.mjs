import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeClaudeStyleAdapter } from './_factories.mjs';

const dir = (home) => existsSync(join(home, '.antigravity'))
  ? join(home, '.antigravity') : join(home, '.gemini', 'antigravity');

export default makeClaudeStyleAdapter({
  name: 'antigravity', dir, confidence: 'speculative',
  events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'],
  notes: 'Convention-based Gemini-style Antigravity hooks.',
});
