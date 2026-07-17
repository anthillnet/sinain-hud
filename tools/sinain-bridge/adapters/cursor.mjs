import { makeCursorStyleAdapter } from './_factories.mjs';

export default makeCursorStyleAdapter({
  name: 'cursor', dir: '.cursor', confidence: 'doc-derived',
  events: ['beforeShellExecution', 'beforeMCPExecution', 'afterFileEdit', 'stop', 'sessionStart'],
  cursorAckEvents: ['beforeShellExecution', 'beforeMCPExecution'],
  notes: 'Cursor IDE hooks; monitor-only before-event acknowledgements.',
});
