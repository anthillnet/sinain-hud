"""SSIM-based frame change detection — re-exported from sinain-sense (gates.ssim)."""

from . import _pkg_boot  # noqa: F401 — puts sinain_sense on sys.path
from sinain_sense.gates.ssim import ChangeDetector, ChangeResult

__all__ = ["ChangeDetector", "ChangeResult"]
