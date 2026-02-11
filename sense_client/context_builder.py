"""Structured context builder for agent consumption.

Generates token-efficient, structured JSON output that the agent can
easily parse and understand. Replaces raw OCR text with semantic data.
"""

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from .semantic import SemanticState, SemanticBuilder, ActivityType


@dataclass
class ContextSnapshot:
    """A single context snapshot in the history."""
    state: SemanticState
    ts: float
    id: int


@dataclass
class ContextQuery:
    """Query parameters for context retrieval."""
    since_ts: Optional[float] = None  # Events since this timestamp
    limit: int = 10  # Max events to return
    include_deltas: bool = True  # Include text deltas
    include_summary: bool = True  # Include visible summary
    compact: bool = False  # Minimize token usage


class ContextBuilder:
    """Builds and manages structured context for the agent.

    Maintains a history of semantic states and provides efficient
    query interfaces for different context needs.
    """

    def __init__(self, max_history: int = 30, builder: Optional[SemanticBuilder] = None):
        """
        Args:
            max_history: Maximum number of snapshots to keep.
            builder: Optional SemanticBuilder instance (creates new if None).
        """
        self.max_history = max_history
        self.builder = builder or SemanticBuilder()
        self._history: deque[ContextSnapshot] = deque(maxlen=max_history)
        self._next_id = 1

        # Aggregated stats
        self.total_snapshots = 0
        self.total_tokens_saved = 0  # Estimated vs raw OCR

    def add_event(self, ocr_text: str, app: str, window: str,
                  ssim: float, app_changed: bool,
                  window_changed: bool) -> SemanticState:
        """Add a new sense event and build semantic state.

        Args:
            ocr_text: Raw OCR text.
            app: Application name.
            window: Window title.
            ssim: SSIM change score.
            app_changed: Whether app just changed.
            window_changed: Whether window just changed.

        Returns:
            Built SemanticState.
        """
        # Reset delta encoder on app change for fresh start
        if app_changed:
            self.builder.reset()

        state = self.builder.build(
            ocr_text=ocr_text,
            app=app,
            window=window,
            ssim=ssim,
            app_changed=app_changed,
            window_changed=window_changed,
        )

        snapshot = ContextSnapshot(
            state=state,
            ts=state.ts,
            id=self._next_id,
        )
        self._next_id += 1
        self._history.append(snapshot)
        self.total_snapshots += 1

        # Estimate tokens saved (raw OCR vs semantic)
        raw_tokens = len(ocr_text) // 4
        semantic_tokens = state.token_estimate
        self.total_tokens_saved += max(0, raw_tokens - semantic_tokens)

        return state

    def query(self, params: Optional[ContextQuery] = None) -> dict:
        """Query context history.

        Args:
            params: Query parameters (uses defaults if None).

        Returns:
            Structured context dict ready for agent consumption.
        """
        params = params or ContextQuery()
        now = time.time()

        # Filter by time
        if params.since_ts:
            snapshots = [s for s in self._history if s.ts >= params.since_ts]
        else:
            snapshots = list(self._history)

        # Limit results
        snapshots = snapshots[-params.limit:]

        if params.compact:
            return self._build_compact(snapshots, now)
        return self._build_full(snapshots, params, now)

    def _build_full(self, snapshots: list[ContextSnapshot],
                    params: ContextQuery, now: float) -> dict:
        """Build full context response."""
        if not snapshots:
            return self._empty_context(now)

        latest = snapshots[-1].state

        # Build events list
        events = []
        for snap in snapshots:
            event = {
                "id": snap.id,
                "ago_s": round(now - snap.ts, 1),
                "activity": snap.state.activity.value,
            }

            if params.include_deltas and snap.state.text_deltas:
                event["changes"] = [
                    {"type": d.type, "location": d.location, "delta": d.content}
                    for d in snap.state.text_deltas[:5]  # Limit deltas
                ]

            if snap.state.has_error:
                event["has_error"] = True

            events.append(event)

        result = {
            "context": {
                "app": latest.app,
                "window": latest.window,
                "activity": latest.activity.value,
                "activity_duration_s": round(latest.activity_duration_s, 1),
            },
            "events": events,
            "visible": {},
            "meta": {
                "ts": int(now * 1000),
                "event_count": len(events),
                "token_estimate": sum(s.state.token_estimate for s in snapshots),
            },
        }

        if params.include_summary and latest.visible_summary:
            result["visible"]["summary"] = latest.visible_summary

        if latest.has_error:
            result["visible"]["has_error"] = True
        if latest.has_unsaved:
            result["visible"]["has_unsaved"] = True

        return result

    def _build_compact(self, snapshots: list[ContextSnapshot], now: float) -> dict:
        """Build minimal compact context."""
        if not snapshots:
            return self._empty_context(now)

        latest = snapshots[-1].state

        # Aggregate changes
        all_changes = []
        for snap in snapshots[-5:]:  # Last 5 only
            for d in snap.state.text_deltas[:3]:
                all_changes.append(f"{d.type}: {d.content[:50]}")

        return {
            "app": latest.app,
            "activity": latest.activity.value,
            "duration_s": round(latest.activity_duration_s),
            "changes": all_changes[-5:] if all_changes else None,
            "error": latest.has_error or None,
            "ts": int(now * 1000),
        }

    def _empty_context(self, now: float) -> dict:
        """Return empty context structure."""
        return {
            "context": {
                "app": "unknown",
                "window": "",
                "activity": "unknown",
                "activity_duration_s": 0,
            },
            "events": [],
            "visible": {},
            "meta": {
                "ts": int(now * 1000),
                "event_count": 0,
                "token_estimate": 0,
            },
        }

    def get_latest(self) -> Optional[SemanticState]:
        """Get the most recent semantic state."""
        if self._history:
            return self._history[-1].state
        return None

    def get_activity_summary(self, window_s: float = 60) -> dict:
        """Get activity summary for a time window.

        Args:
            window_s: Time window in seconds.

        Returns:
            Dict with activity breakdown.
        """
        now = time.time()
        cutoff = now - window_s

        activities = {}
        for snap in self._history:
            if snap.ts < cutoff:
                continue
            activity = snap.state.activity.value
            activities[activity] = activities.get(activity, 0) + 1

        total = sum(activities.values())
        return {
            "window_s": window_s,
            "total_events": total,
            "breakdown": {
                k: {"count": v, "pct": f"{v/total*100:.0f}%"}
                for k, v in sorted(activities.items(), key=lambda x: -x[1])
            } if total > 0 else {},
        }

    def get_app_history(self, limit: int = 10) -> list[dict]:
        """Get recent app transitions.

        Returns:
            List of {app, window, ts, duration_s} entries.
        """
        history = []
        last_app = ""
        last_ts = 0.0

        for snap in self._history:
            if snap.state.app != last_app:
                if last_app:
                    history.append({
                        "app": last_app,
                        "ts": int(last_ts * 1000),
                        "duration_s": round(snap.ts - last_ts, 1),
                    })
                last_app = snap.state.app
                last_ts = snap.ts

        # Add current
        if last_app:
            history.append({
                "app": last_app,
                "ts": int(last_ts * 1000),
                "duration_s": round(time.time() - last_ts, 1),
            })

        return history[-limit:]

    def get_stats(self) -> dict:
        """Get builder statistics."""
        return {
            "total_snapshots": self.total_snapshots,
            "history_size": len(self._history),
            "max_history": self.max_history,
            "total_tokens_saved": self.total_tokens_saved,
        }

    def clear(self) -> None:
        """Clear all history."""
        self._history.clear()
        self.builder.reset()


def format_for_agent(context: dict) -> str:
    """Format context dict as human-readable string for agent consumption.

    This is an alternative to JSON when the agent prefers text format.
    """
    lines = []

    # Header
    ctx = context.get("context", {})
    lines.append(f"[{ctx.get('app', 'unknown')}] {ctx.get('window', '')}")
    lines.append(f"Activity: {ctx.get('activity', 'unknown')} ({ctx.get('activity_duration_s', 0)}s)")

    # Events
    events = context.get("events", [])
    if events:
        lines.append("")
        lines.append("Recent changes:")
        for event in events[-5:]:
            changes = event.get("changes", [])
            if changes:
                for c in changes[:2]:
                    lines.append(f"  [{event.get('ago_s', 0)}s ago] {c.get('type', '?')}: {c.get('delta', '')[:60]}")

    # Visible state
    visible = context.get("visible", {})
    if visible.get("summary"):
        lines.append("")
        lines.append("Visible:")
        lines.append(f"  {visible['summary'][:200]}")

    if visible.get("has_error"):
        lines.append("  ⚠️ Error detected")

    return "\n".join(lines)
