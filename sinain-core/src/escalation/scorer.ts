import type { ContextWindow, EscalationMode } from "../types.js";

/**
 * Score-based escalation decision with documented thresholds.
 *
 * Rationale:
 *   - Errors are most actionable     → +3 (user likely wants help)
 *   - Questions need answers          → +2 (user explicitly asking)
 *   - Code issues are advisory        → +1 (TODO/FIXME/deprecated)
 *   - Rapid app switching = confusion → +1 (user may be lost)
 *
 * Threshold: 3 (an error alone triggers; a question + code issue triggers)
 */
export const ESCALATION_SCORES = {
  error: 3,
  question: 2,
  codeIssue: 1,
  appChurn: 1,
} as const;

export const ESCALATION_THRESHOLD = 3;

const ERROR_PATTERNS = [
  "error", "failed", "failure", "exception", "crash", "traceback",
  "typeerror", "referenceerror", "syntaxerror", "cannot read", "undefined is not",
  "exit code", "segfault", "panic", "fatal", "enoent",
];

const QUESTION_PATTERNS = [
  "how do i", "how to", "what if", "why is", "help me",
  "not working", "stuck", "confused", "any ideas", "suggestions",
];

const CODE_ISSUE_PATTERNS = [
  "todo", "fixme", "hack", "workaround", "deprecated",
];

export interface EscalationScore {
  total: number;
  reasons: string[];
}

/**
 * Calculate escalation score for a given digest and context window.
 * Returns the score and the reasons that contributed.
 */
export function calculateEscalationScore(
  digest: string,
  contextWindow: ContextWindow,
): EscalationScore {
  const digestLower = digest.toLowerCase();
  let total = 0;
  const reasons: string[] = [];

  // Error indicators
  for (const p of ERROR_PATTERNS) {
    if (digestLower.includes(p)) {
      total += ESCALATION_SCORES.error;
      reasons.push(`error:${p}`);
      break;
    }
  }

  // Question/help indicators in audio
  for (const item of contextWindow.audio) {
    const text = (item.text || "").toLowerCase();
    for (const p of QUESTION_PATTERNS) {
      if (text.includes(p)) {
        total += ESCALATION_SCORES.question;
        reasons.push(`question:${p}`);
        break;
      }
    }
    if (reasons.some(r => r.startsWith("question:"))) break;
  }

  // Code issue indicators
  for (const p of CODE_ISSUE_PATTERNS) {
    if (digestLower.includes(p)) {
      total += ESCALATION_SCORES.codeIssue;
      reasons.push(`codeIssue:${p}`);
      break;
    }
  }

  // App churn
  if (contextWindow.appHistory.length >= 4) {
    total += ESCALATION_SCORES.appChurn;
    reasons.push(`appChurn:${contextWindow.appHistory.length}apps`);
  }

  return { total, reasons };
}

/**
 * Decide whether to escalate based on mode, score, cooldown, and dedup.
 */
export function shouldEscalate(
  digest: string,
  hud: string,
  contextWindow: ContextWindow,
  mode: EscalationMode,
  lastEscalationTs: number,
  cooldownMs: number,
  lastEscalatedDigest: string,
): { escalate: boolean; score: EscalationScore } {
  const score = calculateEscalationScore(digest, contextWindow);

  if (mode === "off") return { escalate: false, score };

  // Cooldown check
  if (Date.now() - lastEscalationTs < cooldownMs) return { escalate: false, score };

  // Don't escalate idle
  if (hud === "Idle" || hud === "\u2014") return { escalate: false, score };

  // Focus mode: always escalate (even if digest unchanged)
  if (mode === "focus" || mode === "rich") return { escalate: true, score };

  // Selective mode: dedup identical digests
  if (digest === lastEscalatedDigest) return { escalate: false, score };

  // Selective mode: score-based
  return { escalate: score.total >= ESCALATION_THRESHOLD, score };
}
