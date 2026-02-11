"""Semantic layer: activity classification and delta encoding.

Transforms raw screen data into structured, token-efficient representations
for the agent. Reduces token usage by ~70% through delta encoding and
activity classification.
"""

import difflib
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ActivityType(Enum):
    """Classified user activity types."""
    TYPING = "typing"
    SCROLLING = "scrolling"
    NAVIGATION = "navigation"  # App/tab switch
    READING = "reading"
    ERROR = "error"  # Error dialog or message
    LOADING = "loading"
    IDLE = "idle"
    UNKNOWN = "unknown"


@dataclass
class ActivitySignals:
    """Raw signals used for activity classification."""
    change_rate: float = 0.0  # Changes per second
    change_size: int = 0  # Bytes of change
    vertical_motion: float = 0.0  # Estimated scroll pixels
    horizontal_motion: float = 0.0
    app_changed: bool = False
    window_changed: bool = False
    url_changed: bool = False
    duration_s: float = 0.0  # Time in current state
    ocr_contains_error: bool = False
    ocr_contains_loading: bool = False


@dataclass
class TextDelta:
    """A single text change."""
    type: str  # "add", "remove", "modify"
    location: str  # Line number or description
    content: str  # The actual change
    context: str = ""  # Surrounding text for context


@dataclass
class SemanticState:
    """Structured semantic representation of screen state."""
    app: str = ""
    window: str = ""
    activity: ActivityType = ActivityType.UNKNOWN
    activity_duration_s: float = 0.0

    # Text changes (delta encoded)
    text_deltas: list[TextDelta] = field(default_factory=list)

    # Visible context (summarized)
    visible_summary: str = ""
    cursor_line: Optional[int] = None
    has_error: bool = False
    has_unsaved: bool = False

    # Metadata
    ts: float = 0.0
    token_estimate: int = 0


class ActivityClassifier:
    """Classifies user activity from screen signals.

    Uses heuristics to identify what the user is doing based on
    visual change patterns, OCR content, and app context.
    """

    # Error indicators in OCR text
    ERROR_PATTERNS = [
        r'\berror\b', r'\bexception\b', r'\bfailed\b', r'\bfailure\b',
        r'\bcrash\b', r'\bdenied\b', r'\bunauthorized\b', r'\btimeout\b',
        r'\bcannot\b', r'\bunable\b', r'\binvalid\b', r'\bwarning\b',
    ]

    # Loading indicators
    LOADING_PATTERNS = [
        r'\bloading\b', r'\bplease wait\b', r'\bprocessing\b',
        r'\bconnecting\b', r'\bsyncing\b', r'\buploading\b', r'\bdownloading\b',
    ]

    def __init__(self):
        self.error_re = re.compile('|'.join(self.ERROR_PATTERNS), re.IGNORECASE)
        self.loading_re = re.compile('|'.join(self.LOADING_PATTERNS), re.IGNORECASE)

        # State tracking
        self.last_activity = ActivityType.UNKNOWN
        self.activity_start_ts = time.time()
        self.last_ocr = ""

    def _detect_error_content(self, ocr_text: str) -> bool:
        """Check if OCR text contains error indicators."""
        return bool(self.error_re.search(ocr_text))

    def _detect_loading_content(self, ocr_text: str) -> bool:
        """Check if OCR text contains loading indicators."""
        return bool(self.loading_re.search(ocr_text))

    def classify(self, signals: ActivitySignals, ocr_text: str = "") -> ActivityType:
        """Classify current activity from signals.

        Args:
            signals: ActivitySignals with measured values.
            ocr_text: Current OCR text for content analysis.

        Returns:
            Classified ActivityType.
        """
        now = time.time()

        # Navigation: app or window changed
        if signals.app_changed or signals.window_changed or signals.url_changed:
            self._update_state(ActivityType.NAVIGATION, now)
            return ActivityType.NAVIGATION

        # Error: OCR contains error indicators
        if signals.ocr_contains_error or self._detect_error_content(ocr_text):
            self._update_state(ActivityType.ERROR, now)
            return ActivityType.ERROR

        # Loading: OCR contains loading indicators
        if signals.ocr_contains_loading or self._detect_loading_content(ocr_text):
            self._update_state(ActivityType.LOADING, now)
            return ActivityType.LOADING

        # Typing: frequent small changes
        if signals.change_rate > 2 and signals.change_size < 100:
            self._update_state(ActivityType.TYPING, now)
            return ActivityType.TYPING

        # Scrolling: vertical motion detected
        if signals.vertical_motion > 50:
            self._update_state(ActivityType.SCROLLING, now)
            return ActivityType.SCROLLING

        # Reading: low change rate for extended period
        if signals.change_rate < 0.5 and signals.duration_s > 5:
            self._update_state(ActivityType.READING, now)
            return ActivityType.READING

        # Idle: no changes for extended period
        if signals.change_rate < 0.1 and signals.duration_s > 30:
            self._update_state(ActivityType.IDLE, now)
            return ActivityType.IDLE

        # Default: maintain previous or unknown
        return self.last_activity

    def _update_state(self, activity: ActivityType, now: float) -> None:
        """Update activity state tracking."""
        if activity != self.last_activity:
            self.activity_start_ts = now
        self.last_activity = activity

    def get_duration(self) -> float:
        """Get duration of current activity in seconds."""
        return time.time() - self.activity_start_ts


class DeltaEncoder:
    """Computes and encodes text deltas between states.

    Instead of sending full OCR text each time, computes the diff
    and sends only what changed. This dramatically reduces token usage.
    """

    def __init__(self, context_lines: int = 1):
        """
        Args:
            context_lines: Number of context lines around changes.
        """
        self.context_lines = context_lines
        self.last_text = ""
        self.last_lines: list[str] = []

    def encode(self, current_text: str) -> list[TextDelta]:
        """Compute deltas from last state.

        Args:
            current_text: Current OCR text.

        Returns:
            List of TextDelta objects describing changes.
        """
        if not self.last_text:
            self.last_text = current_text
            self.last_lines = current_text.split('\n')
            # First time: return summary, not full text
            return [TextDelta(
                type="initial",
                location="full",
                content=self._summarize(current_text),
            )]

        current_lines = current_text.split('\n')
        deltas = []

        # Use difflib to find changes
        matcher = difflib.SequenceMatcher(None, self.last_lines, current_lines)

        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'equal':
                continue

            if tag == 'insert':
                content = '\n'.join(current_lines[j1:j2])
                deltas.append(TextDelta(
                    type="add",
                    location=f"line {j1 + 1}",
                    content=self._truncate(content, 200),
                    context=self._get_context(current_lines, j1, j2),
                ))

            elif tag == 'delete':
                content = '\n'.join(self.last_lines[i1:i2])
                deltas.append(TextDelta(
                    type="remove",
                    location=f"line {i1 + 1}",
                    content=self._truncate(content, 200),
                ))

            elif tag == 'replace':
                old_content = '\n'.join(self.last_lines[i1:i2])
                new_content = '\n'.join(current_lines[j1:j2])

                # Try to find specific character change for small edits
                if len(old_content) < 100 and len(new_content) < 100:
                    diff_desc = self._describe_change(old_content, new_content)
                else:
                    diff_desc = self._truncate(new_content, 200)

                deltas.append(TextDelta(
                    type="modify",
                    location=f"line {i1 + 1}",
                    content=diff_desc,
                    context=self._get_context(current_lines, j1, j2),
                ))

        # Update state
        self.last_text = current_text
        self.last_lines = current_lines

        return deltas

    def _summarize(self, text: str, max_len: int = 500) -> str:
        """Create a brief summary of text content."""
        lines = text.split('\n')
        if len(lines) <= 5:
            return text[:max_len]

        # Return first few and last few lines
        summary = '\n'.join(lines[:3]) + f'\n... ({len(lines)} lines total) ...\n' + '\n'.join(lines[-2:])
        return summary[:max_len]

    def _truncate(self, text: str, max_len: int) -> str:
        """Truncate text to max length."""
        if len(text) <= max_len:
            return text
        return text[:max_len - 3] + '...'

    def _get_context(self, lines: list[str], start: int, end: int) -> str:
        """Get context lines around a change."""
        ctx_start = max(0, start - self.context_lines)
        ctx_end = min(len(lines), end + self.context_lines)

        ctx_lines = []
        for i in range(ctx_start, ctx_end):
            prefix = ">" if start <= i < end else " "
            ctx_lines.append(f"{prefix} {lines[i]}")

        return '\n'.join(ctx_lines)

    def _describe_change(self, old: str, new: str) -> str:
        """Describe a small text change concisely."""
        # Find what was added/removed using character diff
        s = difflib.SequenceMatcher(None, old, new)
        changes = []

        for tag, i1, i2, j1, j2 in s.get_opcodes():
            if tag == 'insert':
                changes.append(f"added `{new[j1:j2]}`")
            elif tag == 'delete':
                changes.append(f"removed `{old[i1:i2]}`")
            elif tag == 'replace':
                changes.append(f"changed `{old[i1:i2]}` to `{new[j1:j2]}`")

        if changes:
            return '; '.join(changes[:3])  # Limit to 3 changes
        return new

    def reset(self) -> None:
        """Reset encoder state."""
        self.last_text = ""
        self.last_lines = []


class SemanticBuilder:
    """Builds structured semantic representations from raw sense data.

    Combines activity classification, delta encoding, and context
    summarization to create token-efficient representations.
    """

    def __init__(self):
        self.classifier = ActivityClassifier()
        self.delta_encoder = DeltaEncoder()
        self.last_app = ""
        self.last_window = ""
        self.last_build_ts = 0.0

    def build(self, ocr_text: str, app: str, window: str,
              ssim: float, app_changed: bool,
              window_changed: bool) -> SemanticState:
        """Build semantic state from raw data.

        Args:
            ocr_text: Extracted OCR text.
            app: Current application name.
            window: Current window title.
            ssim: SSIM score from change detection.
            app_changed: Whether app just changed.
            window_changed: Whether window just changed.

        Returns:
            SemanticState with structured representation.
        """
        now = time.time()
        time_since_last = now - self.last_build_ts if self.last_build_ts > 0 else 0

        # Build activity signals
        change_rate = (1.0 - ssim) * 10 if ssim < 1.0 else 0  # Rough estimate
        change_size = len(ocr_text) - len(self.delta_encoder.last_text) if self.delta_encoder.last_text else len(ocr_text)

        signals = ActivitySignals(
            change_rate=change_rate,
            change_size=abs(change_size),
            app_changed=app_changed,
            window_changed=window_changed,
            duration_s=self.classifier.get_duration(),
            ocr_contains_error=self.classifier._detect_error_content(ocr_text),
            ocr_contains_loading=self.classifier._detect_loading_content(ocr_text),
        )

        # Classify activity
        activity = self.classifier.classify(signals, ocr_text)

        # Compute text deltas
        deltas = self.delta_encoder.encode(ocr_text)

        # Detect error/unsaved indicators
        has_error = signals.ocr_contains_error
        has_unsaved = '*' in window or 'unsaved' in window.lower() or 'modified' in window.lower()

        # Build state
        state = SemanticState(
            app=app,
            window=window,
            activity=activity,
            activity_duration_s=self.classifier.get_duration(),
            text_deltas=deltas,
            visible_summary=self._create_summary(ocr_text, deltas),
            has_error=has_error,
            has_unsaved=has_unsaved,
            ts=now,
        )

        # Estimate token count
        state.token_estimate = self._estimate_tokens(state)

        # Update state
        self.last_app = app
        self.last_window = window
        self.last_build_ts = now

        return state

    def _create_summary(self, ocr_text: str, deltas: list[TextDelta]) -> str:
        """Create a brief visible content summary."""
        if not deltas:
            return ""

        # If we have deltas, summarize them
        if len(deltas) == 1 and deltas[0].type == "initial":
            return deltas[0].content

        summary_parts = []
        for d in deltas[:3]:  # Max 3 deltas in summary
            if d.type == "add":
                summary_parts.append(f"+ {d.content[:50]}")
            elif d.type == "remove":
                summary_parts.append(f"- {d.content[:50]}")
            elif d.type == "modify":
                summary_parts.append(f"~ {d.content[:50]}")

        return '\n'.join(summary_parts)

    def _estimate_tokens(self, state: SemanticState) -> int:
        """Rough estimate of tokens in the semantic state."""
        # Rough: ~4 chars per token
        total_chars = len(state.app) + len(state.window) + len(state.visible_summary)
        for d in state.text_deltas:
            total_chars += len(d.content) + len(d.context) + len(d.location)
        return total_chars // 4 + 50  # Add overhead for structure

    def to_json(self, state: SemanticState) -> dict:
        """Convert semantic state to JSON-serializable dict."""
        return {
            "context": {
                "app": state.app,
                "window": state.window,
                "activity": state.activity.value,
                "duration_s": round(state.activity_duration_s, 1),
            },
            "changes": [
                {
                    "type": d.type,
                    "location": d.location,
                    "delta": d.content,
                }
                for d in state.text_deltas
            ],
            "visible": {
                "summary": state.visible_summary,
                "has_error": state.has_error,
                "has_unsaved": state.has_unsaved,
            },
            "meta": {
                "ts": int(state.ts * 1000),
                "token_estimate": state.token_estimate,
            },
        }

    def reset(self) -> None:
        """Reset builder state (e.g., on app change)."""
        self.delta_encoder.reset()
        self.last_app = ""
        self.last_window = ""
