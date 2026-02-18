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
