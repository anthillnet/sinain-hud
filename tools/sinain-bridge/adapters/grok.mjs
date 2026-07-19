import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'grok', dir: '.grok', confidence: 'speculative', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'Convention-designed Grok Build CLI hooks; directory-detection gated.' });
