import type { ContextWindow, AgentEntry, EscalationMode } from "../types.js";
import { normalizeAppName } from "../agent/context-window.js";

/** Regex patterns for detecting errors in OCR text. */
const ERROR_PATTERN = /error|failed|exception|crash|traceback|typeerror|referenceerror|syntaxerror|cannot read|enoent|panic|fatal/i;

function hasErrorPattern(text: string): boolean {
  return ERROR_PATTERN.test(text);
}

// ── Coding Context Detection ──

const CODE_EDITORS = [
  "intellij", "idea", "webstorm", "pycharm", "phpstorm", "rider", "goland",
  "vscode", "visual studio code", "cursor", "sublime", "atom", "vim", "nvim",
  "emacs", "xcode", "android studio", "eclipse", "netbeans"
];

const CODE_PLATFORMS = [
  "leetcode", "hackerrank", "codeforces", "codewars", "codechef",
  "topcoder", "exercism", "codesignal", "codility", "interviewbit",
  "algoexpert", "neetcode", "coderpad", "hackerearth", "kattis"
];

const CODE_SIGNALS = [
  // OCR signals that suggest coding context
  "function", "class ", "def ", "const ", "let ", "var ",
  "import ", "from ", "require(", "export ", "interface ",
  "public ", "private ", "return ", "if (", "for (", "while (",
  "error:", "exception", "traceback", "compile", "runtime",
  "test", "assert", "expect(", "describe(", "it(",
  // Problem indicators
  "input:", "output:", "example", "constraints:", "time limit",
  "expected", "given", "return the", "find the", "implement"
];

export interface CodingContextResult {
  coding: boolean;
  needsSolution: boolean;
}

/**
 * Detect if the user is in a coding context and whether they need a solution.
 */
export function isCodingContext(context: ContextWindow): CodingContextResult {
  const app = context.currentApp.toLowerCase();
  const recentOcr = context.screen.slice(0, 3).map(s => s.ocr.toLowerCase()).join(" ");

  // In a code editor?
  const inEditor = CODE_EDITORS.some(e => app.includes(e));

  // On a coding platform?
  const onPlatform = CODE_PLATFORMS.some(p => app.includes(p) || recentOcr.includes(p));

  // Has code signals in OCR?
  const codeSignalCount = CODE_SIGNALS.filter(s => recentOcr.includes(s)).length;
  const hasCodeSignals = codeSignalCount >= 3;

  // Problem indicators (suggests user needs a solution, not just coding)
  const problemIndicators = ["input:", "output:", "example", "expected", "given", "constraints"];
  const hasProblemSignals = problemIndicators.filter(p => recentOcr.includes(p)).length >= 2;

  return {
    coding: inEditor || onPlatform || hasCodeSignals,
    needsSolution: onPlatform || hasProblemSignals  // Likely a challenge/problem
  };
}

function getInstructions(mode: EscalationMode, context: ContextWindow): string {
  const { coding, needsSolution } = isCodingContext(context);

  if (needsSolution) {
    // Coding challenge/problem - be very action-oriented
    return `The user is working on a coding problem. Be PROACTIVE and SOLVE IT:

1. Provide a solution approach and working code based on what you can see
2. Include time/space complexity
3. If the problem isn't fully visible, provide the best solution you can based on available context
   - Make reasonable assumptions and state them briefly
   - A partial solution is better than no solution

Do NOT just describe what the user is doing - GIVE THEM THE ANSWER.
Response should be actionable: working code with brief explanation.`;
  }

  if (coding) {
    // General coding (IDE work, debugging) - offer assistance
    return `The user is writing code. Be helpful and proactive:

- If there's an error: investigate and suggest a fix with code
- If they seem stuck: offer specific guidance or code snippets
- If you see an opportunity to help: share relevant insights

Keep responses focused and include code when helpful.
(2-6 sentences + code if applicable)`;
  }

  // Non-coding context - existing behavior
  if (mode === "focus" || mode === "rich") {
    return `Based on the above, ALWAYS provide a brief response for the user's HUD.
Important: Do NOT respond with NO_REPLY — a response is always required in focus mode.
- If there's an error: investigate and suggest a fix
- If they seem stuck: offer guidance
- If they're coding: provide relevant insights
- Otherwise: briefly note what the user is doing and any observations
- Keep your response concise (2-5 sentences)`;
  }

  return `Based on the above, proactively help the user:
- If there's an error: investigate and suggest a fix
- If they seem stuck: offer guidance
- If they're coding: provide relevant insights
- Keep your response concise and actionable (2-5 sentences)`;
}

/**
 * Build a structured escalation message with richness proportional to the context window preset.
 *
 * Expected message sizes:
 *   lean (selective):  ~7 KB  / ~1,700 tokens
 *   standard (focus):  ~25 KB / ~6,000 tokens
 *   rich:              ~111 KB / ~28,000 tokens
 *
 * All fit within the 256 KB HTTP hooks limit and 200K+ model context.
 */
export function buildEscalationMessage(
  digest: string,
  context: ContextWindow,
  entry: AgentEntry,
  mode: EscalationMode,
): string {
  const sections: string[] = [];

  // Header with tick metadata
  sections.push(`[sinain-hud live context — tick #${entry.id}]`);

  // Digest (always full)
  sections.push(`## Digest\n${digest}`);

  // Active context
  const currentApp = normalizeAppName(context.currentApp);
  sections.push(`## Active Context\nApp: ${currentApp}`);
  if (context.appHistory.length > 0) {
    sections.push(`App history: ${context.appHistory.map(a => normalizeAppName(a.app)).join(" → ")}`);
  }

  // Errors — extracted from OCR, full stack traces in rich mode
  const errors = context.screen.filter(e => hasErrorPattern(e.ocr));
  if (errors.length > 0) {
    sections.push("## Errors (high priority)");
    for (const e of errors) {
      sections.push(`\`\`\`\n${e.ocr.slice(0, context.preset.maxOcrChars)}\n\`\`\``);
    }
  }

  // Screen OCR
  if (context.screen.length > 0) {
    sections.push("## Screen (recent OCR)");
    for (const e of context.screen) {
      const ago = Math.round((Date.now() - e.ts) / 1000);
      const app = normalizeAppName(e.meta.app);
      sections.push(`- [${ago}s ago] [${app}] ${e.ocr.slice(0, context.preset.maxOcrChars)}`);
    }
  }

  // Audio transcripts
  if (context.audio.length > 0) {
    sections.push("## Audio (recent transcripts)");
    for (const e of context.audio) {
      const ago = Math.round((Date.now() - e.ts) / 1000);
      sections.push(`- [${ago}s ago] "${e.text.slice(0, context.preset.maxTranscriptChars)}"`);
    }
  }

  // Mode-specific instructions (now context-aware)
  sections.push(getInstructions(mode, context));

  sections.push("Respond naturally — this will appear on the user's HUD overlay.");

  return sections.join("\n\n");
}
