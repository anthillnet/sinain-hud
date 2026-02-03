import type { ContextWindow, AgentEntry, EscalationMode } from "../types.js";
import { normalizeAppName } from "../agent/context-window.js";

/** Regex patterns for detecting errors in OCR text. */
const ERROR_PATTERN = /error|failed|exception|crash|traceback|typeerror|referenceerror|syntaxerror|cannot read|enoent|panic|fatal/i;

function hasErrorPattern(text: string): boolean {
  return ERROR_PATTERN.test(text);
}

function getInstructions(mode: EscalationMode): string {
  if (mode === "focus" || mode === "rich") {
    return `Based on the above, ALWAYS provide a brief response for the user's HUD.
Important: Do NOT respond with NO_REPLY \u2014 a response is always required in focus mode.
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
  sections.push(`[sinain-hud live context \u2014 tick #${entry.id}]`);

  // Digest (always full)
  sections.push(`## Digest\n${digest}`);

  // Active context
  const currentApp = normalizeAppName(context.currentApp);
  sections.push(`## Active Context\nApp: ${currentApp}`);
  if (context.appHistory.length > 0) {
    sections.push(`App history: ${context.appHistory.map(a => normalizeAppName(a.app)).join(" \u2192 ")}`);
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

  // Mode-specific instructions
  sections.push(getInstructions(mode));

  sections.push("Respond naturally \u2014 this will appear on the user's HUD overlay.");

  return sections.join("\n\n");
}
