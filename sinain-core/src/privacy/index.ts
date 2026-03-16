import type { PrivacyConfig, PrivacyMatrix, PrivacyDest, PrivacyLevel } from "../types.js";

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

export { applyLevel, redactText, summarizeAudio, summarizeOcr } from "./redact.js";
