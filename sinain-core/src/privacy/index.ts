import type { PrivacyConfig, PrivacyMatrix, PrivacyDest, PrivacyLevel } from "../types.js";
import { applyLevel, redactText } from "./redact.js";

let _privacy: PrivacyConfig | undefined;

export function initPrivacy(cfg: PrivacyConfig): void {
  _privacy = cfg;
}

export function getPrivacy(): PrivacyConfig {
  if (!_privacy) throw new Error("Privacy not initialized — call initPrivacy() first");
  return _privacy;
}

export function levelFor(dataType: keyof PrivacyMatrix, dest: PrivacyDest): PrivacyLevel {
  return getPrivacy().matrix[dataType][dest];
}

const DISK_KIND: Record<"audio_transcript" | "screen_ocr" | "window_titles", "audio" | "ocr" | "titles"> = {
  audio_transcript: "audio",
  screen_ocr: "ocr",
  window_titles: "titles",
};

/**
 * Apply the persistent-storage privacy level to text BEFORE it is written to
 * disk (daily notes, pending-session.json, SITUATION.md, feedback logs). Uses
 * the `triple_store` matrix column — the policy for data that persists on disk
 * — so it honors the user's privacy mode end to end ("full" → unchanged,
 * "redacted" → secrets stripped, "summary" → summarized, "none" → dropped).
 * Falls back to secret-stripping if privacy isn't initialized yet (never throws).
 */
export function redactForDisk(
  text: string,
  dataType: "audio_transcript" | "screen_ocr" | "window_titles",
): string {
  try {
    return applyLevel(text, levelFor(dataType, "triple_store"), DISK_KIND[dataType]);
  } catch {
    return redactText(text);
  }
}

export { applyLevel, redactText, summarizeAudio, summarizeOcr } from "./redact.js";
