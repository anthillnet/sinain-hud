"""Robust JSON extraction from LLM responses.

Canonical home of the extractor previously in sinain-memory/common.py —
common.py now delegates here.
"""

from __future__ import annotations

import json
import re


def extract_json(text: str) -> dict | list:
    """Extract a JSON object or array from potentially messy LLM output.

    Three-stage extraction:
      1. Direct json.loads (clean case)
      2. Regex extraction from markdown code fences
      3. Balanced-brace scanner for JSON embedded in prose
         (with truncated-JSON repair)

    Raises ValueError if no valid JSON can be extracted.
    """
    text = text.strip()

    # Stage 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Stage 2: markdown code fences  ```json ... ```  or  ``` ... ```
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Stage 3+4: balanced-brace scanner with truncated JSON repair
    # Uses a full bracket stack so nested {/[ are tracked together.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = text.find(open_ch)
        if start == -1:
            continue
        stack: list[str] = []
        in_string = False
        escape = False
        string_start = -1
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                if in_string:
                    escape = True
                continue
            if ch == '"':
                if not in_string:
                    string_start = i
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch in ("{", "["):
                stack.append("}" if ch == "{" else "]")
            elif ch in ("}", "]"):
                if stack:
                    stack.pop()
                if not stack:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break  # malformed — try next bracket type
        else:
            # Reached end of text with unclosed brackets — attempt repair
            if not stack:
                continue
            closers = "".join(reversed(stack))
            fragment = text[start:]

            # Strategy A: if mid-string, close it then close all brackets
            if in_string:
                try:
                    return json.loads(fragment + '"' + closers)
                except json.JSONDecodeError:
                    pass

            # Strategy B: strip trailing incomplete tokens, close brackets
            stripped = re.sub(r'[,:\s]+$', '', fragment)
            try:
                return json.loads(stripped + closers)
            except json.JSONDecodeError:
                pass

            # Strategy B2: text cut right after a key (`..., "facts": `) —
            # stripping the colon alone leaves a valueless key. Drop the
            # dangling key too, then close.
            no_key = re.sub(r'"[^"\n]*"\s*:?\s*$', '', fragment)
            no_key = re.sub(r'[,:\s]+$', '', no_key)
            if no_key != stripped:
                try:
                    return json.loads(no_key + closers)
                except json.JSONDecodeError:
                    pass

            # Strategy C: if mid-string, cut before the unclosed string,
            # strip trailing tokens, close brackets
            if in_string and string_start >= start:
                before_str = text[start:string_start]
                before_str = re.sub(r'[,:\s]+$', '', before_str)
                try:
                    return json.loads(before_str + closers)
                except json.JSONDecodeError:
                    pass

    raise ValueError(f"No valid JSON found in LLM response ({len(text)} chars): {text[:120]}...")
