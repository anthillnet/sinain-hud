"""JSONL evaluation logger — one line per pipeline cycle.

Captures the full vision→observation→response pipeline for offline quality
evaluation.  Each line is a self-contained JSON object with timestamps,
latencies, and the actual text content flowing through the system.

Files are date-stamped (eval-YYYY-MM-DD.jsonl) so old logs can be cleaned up
without any rotation daemon.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import date

log = logging.getLogger(__name__)


class EvalLogger:
    """Append-only JSONL writer for pipeline evaluation data."""

    def __init__(self, config: dict):
        eval_cfg = config.get("eval", {})
        self._enabled = eval_cfg.get("enabled", True)
        self._log_dir = eval_cfg.get("log_dir", "/tmp/sinain-eval")
        self._current_date: str = ""
        self._fh = None

        if self._enabled:
            os.makedirs(self._log_dir, exist_ok=True)

    def log_cycle(
        self,
        *,
        tick: int,
        classification: str,
        description: str,
        ocr_text: str,
        observation_sent: str,
        agent_response: str,
        vision_latency_ms: float,
        rpc_latency_ms: float,
    ) -> None:
        """Write one JSON line capturing a full pipeline cycle."""
        if not self._enabled:
            return

        record = {
            "timestamp": time.time(),
            "tick": tick,
            "classification": classification,
            "description": description,
            "ocr_text": ocr_text,
            "observation_sent": observation_sent,
            "agent_response": agent_response,
            "vision_latency_ms": round(vision_latency_ms, 1),
            "rpc_latency_ms": round(rpc_latency_ms, 1),
        }

        try:
            self._ensure_file()
            self._fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._fh.flush()
        except Exception:
            log.warning("eval log write failed", exc_info=True)

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None

    # ── internal ──────────────────────────────────────────────────────

    def _ensure_file(self) -> None:
        """Open (or rotate to) the file for today's date."""
        today = date.today().isoformat()
        if today != self._current_date:
            if self._fh is not None:
                self._fh.close()
            path = os.path.join(self._log_dir, f"eval-{today}.jsonl")
            self._fh = open(path, "a", encoding="utf-8")
            self._current_date = today
