import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'mistralvibe', dir: '.mistralvibe', confidence: 'speculative', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'Convention-designed Mistral Vibe hooks; directory-detection gated.' });
