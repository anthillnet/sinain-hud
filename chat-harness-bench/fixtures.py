"""Identical fixtures every adapter runs. `expected_tools` scores tool-use QUALITY:
does the harness actually reach for the right sinain/machine tool, or stall / answer
blind? (One of the two headline axes alongside latency.)"""
from dataclasses import dataclass, field


@dataclass
class Fixture:
    id: str
    prompt: str
    expected_tools: list[str] = field(default_factory=list)  # any-of is a pass
    note: str = ""


FIXTURES = [
    Fixture("no_tool",
            "In one sentence, what is a vector embedding?",
            expected_tools=[],
            note="baseline: no tool needed; pure latency of a reasoning model"),
    Fixture("memory",
            "What do you know about my recent work? Check my memory.",
            expected_tools=["sinain_memory_query"],
            note="must query the knowledge graph"),
    Fixture("vision_context",
            "What's currently on my screen and what am I doing right now?",
            expected_tools=["sinain_context"],
            note="must pull current situation (OCR/vision + audio + apps)"),
    Fixture("machine_orient",
            "What git branch is the sinain-hud repo on, and is the working tree clean? "
            "Look at /Users/Igor.Gerasimov/IdeaProjects/sinain-hud.",
            expected_tools=["bash"],
            note="Claude-Code-like machine orientation via bash"),
    Fixture("multi_tool",
            "Find Python files under the current directory, then tell me one thing from my memory about embeddings.",
            expected_tools=["glob", "bash", "sinain_memory_query"],
            note="multi-step tool chain (lean-core tools: glob/bash + memory)"),
]
