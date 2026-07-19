import { makeClaudeStyleAdapter } from './_factories.mjs';
export default makeClaudeStyleAdapter({ name: 'qwen', dir: '.qwen', confidence: 'doc-derived', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'Notification'], notes: 'Qwen CLI Gemini-compatible hooks.' });
