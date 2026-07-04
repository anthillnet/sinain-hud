"""Put the shared sinain packages (packages/*) on sys.path.

sense_client sits next to packages/ in both layouts (repo root in dev, npm
package root when installed), so the sibling resolve covers both.
SINAIN_LLM_DIR / SINAIN_SENSE_DIR override per package.
"""
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]

for _name, _env in (("sinain-llm", "SINAIN_LLM_DIR"), ("sinain-sense", "SINAIN_SENSE_DIR")):
    _mod = _name.replace("-", "_")
    try:
        __import__(_mod)  # already importable (pip-installed)
        continue
    except ImportError:
        pass
    for _cand in (os.environ.get(_env), str(_ROOT / "packages" / _name)):
        if _cand and (Path(_cand) / _mod / "__init__.py").exists():
            if _cand not in sys.path:
                sys.path.insert(0, _cand)
            break
    else:
        raise ImportError(
            f"{_name} package not found (expected packages/{_name} next to "
            f"sense_client, or set {_env})"
        )
