import { makeCursorStyleAdapter } from './_factories.mjs';
export default makeCursorStyleAdapter({ name: 'trae', dir: '.trae', confidence: 'speculative', events: ['beforeShellExecution', 'beforeMCPExecution', 'afterFileEdit', 'stop', 'sessionStart'], cursorAckEvents: ['beforeShellExecution', 'beforeMCPExecution'], notes: 'Convention-designed Cursor-lineage hooks; directory-detection gated.' });
