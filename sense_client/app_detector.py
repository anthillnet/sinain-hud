"""Detect the frontmost application on macOS."""

import subprocess


class AppDetector:
    """Detects the frontmost application on macOS."""

    def __init__(self):
        self._last_app: str = ""

    def get_active_app(self) -> str:
        """Returns the name of the frontmost application."""
        try:
            result = subprocess.run(
                [
                    "osascript", "-e",
                    'tell application "System Events" to '
                    'name of first application process whose frontmost is true',
                ],
                capture_output=True, text=True, timeout=2,
            )
            return result.stdout.strip()
        except Exception:
            return ""

    def detect_change(self) -> tuple[bool, str]:
        """Returns (changed, app_name)."""
        app = self.get_active_app()
        changed = app != self._last_app and self._last_app != ""
        self._last_app = app
        return changed, app
