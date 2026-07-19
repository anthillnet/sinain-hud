import { makeClaudeStyleAdapter } from './_factories.mjs';

export default makeClaudeStyleAdapter({
  name: 'gemini', dir: '.gemini', confidence: 'doc-derived',
  events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'],
  notes: 'Gemini CLI hooks in settings.json (Gemini CLI 0.9+).',
});
