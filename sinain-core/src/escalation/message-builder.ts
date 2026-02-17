import type { ContextWindow, AgentEntry, EscalationMode, FeedbackRecord } from "../types.js";
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
(5-10 sentences + code if applicable). Be thorough.`;
  }

  // Non-coding context — proactive insights instead of activity descriptions
  if (mode === "focus" || mode === "rich") {
    return `Based on the above, ALWAYS provide a useful response for the user's HUD.
Important: Do NOT respond with NO_REPLY — a response is always required.

- If there's an error: investigate and suggest a fix
- If they seem stuck or asked a question: offer guidance
- If they're reading/browsing content: share a relevant insight, connection to their projects, or practical tip related to what's on screen
- If they're in a conversation or meeting: note key takeaways or action items
- If context is minimal: tell a short, clever joke (tech humor, wordplay, or observational — keep it fresh, never repeat one you've told recently)

NEVER just describe what the user is doing — they can see their own screen.
NEVER respond with "standing by", "monitoring", or similar filler.
Every response must teach something, suggest something, or connect dots the user hasn't noticed.
(2-5 sentences). Be specific and actionable.`;
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
 *
 * In selective mode, sections are prioritized by relevance:
 * - Error escalations prioritize error sections
 * - Question escalations prioritize audio sections
 * - App context is always included
 */
export function buildEscalationMessage(
  digest: string,
  context: ContextWindow,
  entry: AgentEntry,
  mode: EscalationMode,
  escalationReason?: string,
  recentFeedback?: FeedbackRecord[],
): string {
  const sections: string[] = [];

  // Header with tick metadata
  sections.push(`[sinain-hud live context — tick #${entry.id}]`);

  // Digest (always full)
  sections.push(`## Digest\n${digest}`);

  // Active context (always included)
  const currentApp = normalizeAppName(context.currentApp);
  sections.push(`## Active Context\nApp: ${currentApp}`);
  if (context.appHistory.length > 0) {
    sections.push(`App history: ${context.appHistory.map(a => normalizeAppName(a.app)).join(" → ")}`);
  }

  // Errors — extracted from OCR, full stack traces in rich mode
  const errors = context.screen.filter(e => hasErrorPattern(e.ocr));
  const hasErrors = errors.length > 0;
  const hasQuestion = escalationReason?.startsWith("question:");

  // In selective mode, prioritize sections based on escalation reason
  // In focus/rich modes, include everything
  if (mode === "selective") {
    // Error-triggered: prioritize errors, then screen
    if (hasErrors) {
      sections.push("## Errors (high priority)");
      for (const e of errors) {
        sections.push(`\`\`\`\n${e.ocr.slice(0, context.preset.maxOcrChars)}\n\`\`\``);
      }
      // Include screen context (reduced)
      if (context.screen.length > 0) {
        sections.push("## Screen (recent OCR)");
        for (const e of context.screen.slice(0, 5)) { // Limit in selective mode
          const ago = Math.round((Date.now() - e.ts) / 1000);
          const app = normalizeAppName(e.meta.app);
          sections.push(`- [${ago}s ago] [${app}] ${e.ocr.slice(0, context.preset.maxOcrChars)}`);
        }
      }
    }
    // Question-triggered: prioritize audio, then screen
    else if (hasQuestion) {
      if (context.audio.length > 0) {
        sections.push("## Audio (recent transcripts)");
        for (const e of context.audio) {
          const ago = Math.round((Date.now() - e.ts) / 1000);
          sections.push(`- [${ago}s ago] "${e.text.slice(0, context.preset.maxTranscriptChars)}"`);
        }
      }
      // Include screen context (reduced)
      if (context.screen.length > 0) {
        sections.push("## Screen (recent OCR)");
        for (const e of context.screen.slice(0, 5)) {
          const ago = Math.round((Date.now() - e.ts) / 1000);
          const app = normalizeAppName(e.meta.app);
          sections.push(`- [${ago}s ago] [${app}] ${e.ocr.slice(0, context.preset.maxOcrChars)}`);
        }
      }
    }
    // Other triggers: balanced sections
    else {
      if (context.screen.length > 0) {
        sections.push("## Screen (recent OCR)");
        for (const e of context.screen) {
          const ago = Math.round((Date.now() - e.ts) / 1000);
          const app = normalizeAppName(e.meta.app);
          sections.push(`- [${ago}s ago] [${app}] ${e.ocr.slice(0, context.preset.maxOcrChars)}`);
        }
      }
      if (context.audio.length > 0) {
        sections.push("## Audio (recent transcripts)");
        for (const e of context.audio) {
          const ago = Math.round((Date.now() - e.ts) / 1000);
          sections.push(`- [${ago}s ago] "${e.text.slice(0, context.preset.maxTranscriptChars)}"`);
        }
      }
    }
  } else {
    // Focus/rich mode: include all sections
    if (hasErrors) {
      sections.push("## Errors (high priority)");
      for (const e of errors) {
        sections.push(`\`\`\`\n${e.ocr.slice(0, context.preset.maxOcrChars)}\n\`\`\``);
      }
    }

    if (context.screen.length > 0) {
      sections.push("## Screen (recent OCR)");
      for (const e of context.screen) {
        const ago = Math.round((Date.now() - e.ts) / 1000);
        const app = normalizeAppName(e.meta.app);
        sections.push(`- [${ago}s ago] [${app}] ${e.ocr.slice(0, context.preset.maxOcrChars)}`);
      }
    }

    if (context.audio.length > 0) {
      sections.push("## Audio (recent transcripts)");
      for (const e of context.audio) {
        const ago = Math.round((Date.now() - e.ts) / 1000);
        sections.push(`- [${ago}s ago] "${e.text.slice(0, context.preset.maxTranscriptChars)}"`);
      }
    }
  }

  // Mode-specific instructions (now context-aware)
  sections.push(getInstructions(mode, context));

  // Stale escalation hint — forces a proactive response after prolonged silence
  if (escalationReason === "stale") {
    sections.push(`## Note: Stale Escalation
No escalation has happened recently. The user's screen feed is still active but
the local analyzer reported idle/no-change. Provide a PROACTIVE response:
- Share a relevant insight, tip, or connection to what the user was working on earlier
- If context is minimal, tell a short clever joke (tech humor, wordplay — keep it fresh)
- Do NOT describe the idle state or say "standing by"
- Do NOT respond with NO_REPLY — a response is always required for stale escalations`);
  }

  // Append inline feedback summary if available
  if (recentFeedback && recentFeedback.length > 0) {
    sections.push(formatInlineFeedback(recentFeedback));
  }

  sections.push("Respond naturally — this will appear on the user's HUD overlay.");

  return sections.join("\n\n");
}

/**
 * Format a compact inline feedback section for escalation messages.
 * Shows recent performance so the agent can calibrate its response style.
 */
function formatInlineFeedback(records: FeedbackRecord[]): string {
  const withSignals = records.filter(r => r.signals.compositeScore !== 0 || r.signals.errorCleared !== null);
  if (withSignals.length === 0) return "";

  const scores = withSignals.map(r => r.signals.compositeScore);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  const errorsCleared = withSignals.filter(r => r.signals.errorCleared === true).length;
  const errorsTotal = withSignals.filter(r => r.signals.errorCleared !== null).length;
  const reEscalated = withSignals.filter(r => r.signals.noReEscalation === false).length;

  const recentParts = withSignals.slice(0, 5).map(r => {
    const ok = r.signals.compositeScore >= 0.2;
    const icon = ok ? "✓" : "✗";
    const score = r.signals.compositeScore.toFixed(1);
    const tags = r.tags.filter(t => !t.startsWith("app:")).slice(0, 2).join(", ");
    return `${icon} ${score} (${tags || "general"})`;
  });

  const parts = [`Score: ${avg.toFixed(2)} avg`];
  if (errorsTotal > 0) parts.push(`Errors cleared: ${errorsCleared}/${errorsTotal}`);
  parts.push(`Re-escalated: ${reEscalated}/${withSignals.length}`);

  return `## Recent Feedback (last ${withSignals.length} escalations)\n${parts.join(" | ")}\nRecent: ${recentParts.join(" | ")}`;
}
