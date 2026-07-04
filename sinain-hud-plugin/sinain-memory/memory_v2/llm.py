"""LLM transport for compaction — delegates to the shared sinain-llm package.

Keeps memory_v2 PORTABLE: the engine depends only on sinain-llm, not on
sinain-memory's common.py — the prerequisite for extracting it as a pip
package both surfaces share. Mirrors ARSinain's memory_v2/llm.py so the two
forks converge on one shape (DESIGN-SHARED-MODULES step 2).

Compaction is a background job (memoryd's compaction thread / bench), so the
sync sinain-llm client is fine here.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def _resolve():
    """Import the shared sinain_llm package (pip-installed, or resolved from
    packages/sinain-llm at the repo/npm root; SINAIN_LLM_DIR overrides)."""
    try:
        import sinain_llm
        return sinain_llm
    except ImportError:
        pass
    here = Path(__file__).resolve()
    candidates = [os.environ.get("SINAIN_LLM_DIR")]
    # memory_v2/llm.py → memory_v2 → sinain-memory → sinain-hud-plugin → repo root
    # (dev), and the shallower npm-flat layout — try both depths.
    for depth in (3, 2):
        if len(here.parents) > depth:
            candidates.append(str(here.parents[depth] / "packages" / "sinain-llm"))
    for cand in candidates:
        if cand and (Path(cand) / "sinain_llm" / "__init__.py").exists():
            if cand not in sys.path:
                sys.path.insert(0, cand)
            try:
                import sinain_llm
                return sinain_llm
            except ImportError:
                continue
    raise ImportError(
        "sinain-llm package not found (expected packages/sinain-llm at the "
        "repo/npm root; override with SINAIN_LLM_DIR)"
    )


def call_llm(system_prompt: str, user_prompt: str, model: str,
             max_tokens: int = 1500, **kwargs) -> str:
    """Chat-completions call via sinain-llm. Passes through json_mode,
    json_schema, temperature, seed, timeout (see sinain_llm.call_llm)."""
    return _resolve().call_llm(system_prompt, user_prompt, model, max_tokens, **kwargs)


class LLMError(Exception):
    """Raised on LLM failure — aliased to sinain_llm.LLMError at call time."""
