import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'workbuddy', dir: '.workbuddy', confidence: 'speculative', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'Convention-designed WorkBuddy hooks; directory-detection gated.' });
