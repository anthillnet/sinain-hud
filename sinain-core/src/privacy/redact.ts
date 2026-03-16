import type { PrivacyLevel } from "../types.js";

// ── Pattern library ──────────────────────────────────────────────────────────

// AUTH_CREDENTIALS
const AUTH_CREDENTIALS = [
  /\bpassword\s*[:=]\s*\S+/gi,
  /\bpasswd\s*[:=]\s*\S+/gi,
  /\bsecret\s*[:=]\s*\S+/gi,
  /\bpwd\s*[:=]\s*\S+/gi,
  /\bpin\s*[:=]\s*\d{4,8}\b/gi,
];

// API_TOKENS
const API_TOKENS = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bghp_[A-Za-z0-9]{36}/g,
  /\bghs_[A-Za-z0-9]{36}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[bpoa]-[0-9A-Za-z-]+/g,
  /\bya29\.[0-9A-Za-z-_]+/g,
  /\beyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
  /\bapi[_-]?key\s*[:=]\s*\S+/gi,
];

// FINANCIAL
const FINANCIAL = [
  // Luhn-matching card numbers (16 digits with optional separators)
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  /\bCVV\s*[:=]?\s*\d{3,4}\b/gi,
  /\bIBAN\s*[:=]?\s*[A-Z]{2}\d{2}[\dA-Z]{4,30}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
];

// PII_CONTACT
const PII_CONTACT = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, // US phone
  /\+\d{1,3}\s\d{1,4}[\s.-]\d{3,4}[\s.-]\d{4,9}/g, // international phone
];

// HEALTH
const HEALTH = [
  /\bMRN\s*[:=]?\s*\d{6,10}\b/gi,
  /\b(diagnosis|prescription|patient ID)\s*[:=]\s*\S+/gi,
];

const ALL_PATTERNS: RegExp[] = [
  ...AUTH_CREDENTIALS,
  ...API_TOKENS,
  ...FINANCIAL,
  ...PII_CONTACT,
  ...HEALTH,
];

export function redactText(text: string): string {
  let result = text;
  for (const pattern of ALL_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function summarizeAudio(text: string): string {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return `[AUDIO: ${wordCount} words]`;
}

export function summarizeOcr(text: string): string {
  return `[SCREEN: ${text.length} chars]`;
}

export function applyLevel(
  text: string,
  level: PrivacyLevel,
  dataType: "audio" | "ocr" | "titles" = "ocr"
): string {
  switch (level) {
    case "full":
      return text;
    case "redacted":
      return redactText(text);
    case "summary":
      if (dataType === "audio") return summarizeAudio(text);
      return summarizeOcr(text);
    case "none":
      return "";
    default:
      return text;
  }
}
