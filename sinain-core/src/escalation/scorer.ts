import type { ContextWindow, EscalationMode } from "../types.js";
import { log } from "../log.js";

const TAG = "scorer";

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

/**
 * Error patterns with word boundary matching.
 * Using regex with \b prevents false positives like "error-free" or "no-fail".
 */
const ERROR_PATTERNS = [
  "error", "failed", "failure", "exception", "crash", "traceback",
  "typeerror", "referenceerror", "syntaxerror", "cannot read", "undefined is not",
  "exit code", "segfault", "panic", "fatal", "enoent",
];

/**
 * Question patterns for detecting when user needs help.
 * Checked in audio transcripts and screen OCR.
 */
const QUESTION_PATTERNS = [
  "how do i", "how to", "what if", "why is", "help me",
  "not working", "stuck", "confused", "any ideas", "suggestions",
];

const CODE_ISSUE_PATTERNS = [
  "todo", "fixme", "hack", "workaround", "deprecated",
];

/**
 * Check if pattern matches with word boundaries.
 * Prevents false positives like "error-free" matching "error".
 */
function matchesWordBoundary(text: string, pattern: string): boolean {
  const regex = new RegExp(`\\b${pattern}\\b`, 'i');
  return regex.test(text);
}

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

  // Error indicators (using word boundaries to avoid false positives like "error-free")
  for (const p of ERROR_PATTERNS) {
    if (matchesWordBoundary(digestLower, p)) {
      total += ESCALATION_SCORES.error;
      reasons.push(`error:${p}`);
      break;
    }
  }

  // Question/help indicators in audio
  let questionDetected = false;
  for (const item of contextWindow.audio) {
    if (questionDetected) break;
    const text = (item.text || "").toLowerCase();
    for (const p of QUESTION_PATTERNS) {
      if (text.includes(p)) {
        total += ESCALATION_SCORES.question;
        reasons.push(`question:audio:${p}`);
        questionDetected = true;
        break;
      }
    }
  }

  // Question/help indicators in screen OCR (catches typed questions in chat/search)
  if (!questionDetected) {
    for (const item of contextWindow.screen) {
      if (questionDetected) break;
      const ocrText = (item.ocr || "").toLowerCase();
      for (const p of QUESTION_PATTERNS) {
        if (ocrText.includes(p)) {
          total += ESCALATION_SCORES.question;
          reasons.push(`question:ocr:${p}`);
          questionDetected = true;
          break;
        }
      }
    }
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
 * Decide whether to escalate based on mode, score, cooldown, dedup, and stale timer.
 */
export function shouldEscalate(
  digest: string,
  hud: string,
  contextWindow: ContextWindow,
  mode: EscalationMode,
  lastEscalationTs: number,
  cooldownMs: number,
  lastEscalatedDigest: string,
  staleMs: number = 0,
): { escalate: boolean; score: EscalationScore; stale: boolean } {
  const score = calculateEscalationScore(digest, contextWindow);
  const lastEscalationAge = Date.now() - lastEscalationTs;
  log(TAG, `shouldEscalate: mode=${mode} cooldown=${cooldownMs}ms staleMs=${staleMs} lastEscalationAge=${lastEscalationAge}ms score=${score.total} reasons=[${score.reasons.join(",")}] hud="${hud.slice(0, 40)}"`);

  if (mode === "off") {
    log(TAG, "suppressed: mode=off");
    return { escalate: false, score, stale: false };
  }

  // Rich/focus: always escalate — bypasses cooldown, idle guard, and dedup
  if (mode === "focus" || mode === "rich") {
    log(TAG, "escalating: rich/focus mode bypass");
    return { escalate: true, score, stale: false };
  }

  // Cooldown check (selective mode only)
  if (lastEscalationAge < cooldownMs) {
    const remaining = Math.round((cooldownMs - lastEscalationAge) / 1000);
    log(TAG, `suppressed: cooldown active (${remaining}s remaining)`);
    return { escalate: false, score, stale: false };
  }

  // Stale override: force escalation after prolonged silence (even when idle)
  if (staleMs > 0 && lastEscalationAge > staleMs) {
    log(TAG, "escalating: stale override");
    return { escalate: true, score, stale: true };
  }

  // Don't escalate idle (selective mode only)
  if (hud === "Idle" || hud === "\u2014") {
    log(TAG, `suppressed: hud idle ("${hud}")`);
    return { escalate: false, score, stale: false };
  }

  // Selective mode: dedup identical digests
  if (digest === lastEscalatedDigest) {
    log(TAG, "suppressed: digest unchanged");
    return { escalate: false, score, stale: false };
  }

  // Selective mode: score-based
  if (score.total < ESCALATION_THRESHOLD) {
    log(TAG, `suppressed: score too low (${score.total} < ${ESCALATION_THRESHOLD})`);
    return { escalate: false, score, stale: false };
  }

  const reasons = score.reasons.join(",");
  log(TAG, `escalating: score ${score.total} reasons=[${reasons}]`);
  return { escalate: true, score, stale: false };
}
