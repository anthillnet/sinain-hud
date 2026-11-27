"""The one adapter contract every candidate harness must satisfy.

This IS the WebSocket event vocabulary the overlay needs (docs/chat-harness-evaluation.md
§7), so the winning adapter is the production integration — swapping harnesses later
is a one-file change.

Each adapter wraps a harness (OpenHands SDK, Hermes, smolagents, gptme, or a TS
control) and exposes a single streaming `run()`. The runner is harness-agnostic.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

EventType = Literal["token", "tool_call", "tool_result", "progress", "done", "error"]


@dataclass
class Event:
    """One streamed event. `token` carries assistant CONTENT deltas only — NOT
    reasoning deltas (deepseek-v4-flash is a reasoning model; first-content-token
    is the latency metric, so reasoning must not be miscounted as content)."""
    type: EventType
    text: str = ""                       # token content / progress note / error msg
    tool_name: str = ""                  # for tool_call / tool_result
    tool_args: dict = field(default_factory=dict)
    tool_result: str = ""                # for tool_result
    ts: float = field(default_factory=time.perf_counter)


@dataclass
class ChatContext:
    """MAIN-thread digest or ROI region context injected per turn."""
    kind: Literal["main", "roi"] = "main"
    seed: str = ""                       # digest text or region task context
    region_id: str | None = None


class Adapter(ABC):
    """Implement once per candidate harness."""

    name: str = "abstract"

    @abstractmethod
    async def setup(self) -> None:
        """Resident warm-up: load the harness, register sinain tools, open the model
        client. Called ONCE; its cost is the boot-once cost (excluded from per-turn
        latency)."""

    @abstractmethod
    def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        """Stream events for one chat turn. MUST yield content tokens as `token`
        events and tool activity as `tool_call`/`tool_result`, ending with `done`."""

    @abstractmethod
    async def cancel(self) -> None:
        """Interrupt an in-flight run (the WS interrupt path)."""

    async def teardown(self) -> None:
        """Optional cleanup."""
