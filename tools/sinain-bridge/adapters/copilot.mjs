import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'copilot', dir: '.copilot', confidence: 'doc-derived', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'GitHub Copilot CLI hooks in settings.json.' });
