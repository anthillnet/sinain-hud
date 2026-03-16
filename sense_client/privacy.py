"""Privacy filter — strips <private> tags and auto-redacts sensitive patterns from OCR text."""

import re

# Patterns that auto-redact without manual tagging
_REDACT_PATTERNS: list[tuple[re.Pattern, str]] = [
    # Credit card numbers (4 groups of 4 digits)
    (re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"), "[REDACTED:card]"),
    # API keys / tokens (long hex or base64 strings)
    (re.compile(r"\b(?:sk-|pk-|api[_-]?key[=:]\s*)[A-Za-z0-9_\-]{20,}\b"), "[REDACTED:apikey]"),
    # Bearer tokens
    (re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{20,}"), "[REDACTED:bearer]"),
    # AWS secret keys
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED:awskey]"),
    # Passwords in assignment context
    (re.compile(r"(?:password|passwd|pwd)\s*[:=]\s*\S+", re.IGNORECASE), "[REDACTED:password]"),
    # GitHub personal access tokens
    (re.compile(r"\bghp_[A-Za-z0-9]{36}\b"), "[REDACTED:github_pat]"),
    # GitHub server tokens
    (re.compile(r"\bghs_[A-Za-z0-9]{36}\b"), "[REDACTED:github_srv]"),
    # Slack tokens
    (re.compile(r"\bxox[bpoa]-[0-9A-Za-z\-]+"), "[REDACTED:slack]"),
    # Google OAuth tokens
    (re.compile(r"\bya29\.[0-9A-Za-z\-_]+"), "[REDACTED:google_oauth]"),
    # JWT tokens (three base64url segments)
    (re.compile(r"\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"), "[REDACTED:jwt]"),
    # Generic secrets / keys in assignment context
    (re.compile(r"(?:secret|token|key)\s*[:=]\s*[A-Za-z0-9_\-\.]{10,}", re.IGNORECASE), "[REDACTED:secret]"),
    # Email addresses
    (re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), "[REDACTED:email]"),
    # US phone numbers
    (re.compile(r"\+?1?\s?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b"), "[REDACTED:phone]"),
    # SSN (XXX-XX-XXXX)
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[REDACTED:ssn]"),
    # CVV codes
    (re.compile(r"\bCVV\s*[:=]?\s*\d{3,4}\b", re.IGNORECASE), "[REDACTED:cvv]"),
    # PIN codes in assignment context
    (re.compile(r"\bpin\s*[:=]\s*\d{4,8}\b", re.IGNORECASE), "[REDACTED:pin]"),
    # Private key headers
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "[REDACTED:privkey]"),
    # MRN (medical record numbers)
    (re.compile(r"\bMRN\s*[:=]?\s*\d{6,10}\b", re.IGNORECASE), "[REDACTED:mrn]"),
]

# Matches <private>...</private> blocks (including multiline)
_PRIVATE_TAG = re.compile(r"<private>.*?</private>", re.DOTALL)


def strip_private(text: str) -> str:
    """Remove <private>...</private> blocks from text."""
    return _PRIVATE_TAG.sub("", text).strip()


def redact_sensitive(text: str) -> str:
    """Auto-redact patterns that look like secrets or PII."""
    for pattern, replacement in _REDACT_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def apply_privacy(text: str) -> str:
    """Full privacy pipeline: strip private tags, then auto-redact."""
    text = strip_private(text)
    text = redact_sensitive(text)
    return text
