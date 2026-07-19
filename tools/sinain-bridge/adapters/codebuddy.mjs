import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'codebuddy', dir: '.codebuddy', confidence: 'speculative', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'Convention-designed CodeBuddy hooks; directory-detection gated.' });
