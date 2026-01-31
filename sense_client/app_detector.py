"""Detect the frontmost application and window title on macOS."""

import subprocess


class AppDetector:
    """Detects the frontmost application and window title on macOS."""

    def __init__(self):
        self._last_app: str = ""
        self._last_window: str = ""

    def get_active_app(self) -> tuple[str, str]:
        """Returns (app_name, window_title) of the frontmost application."""
        try:
            result = subprocess.run(
                [
                    "osascript", "-e",
                    'tell application "System Events"\n'
                    '  set appProc to first application process whose frontmost is true\n'
                    '  set appName to name of appProc\n'
                    '  set winTitle to ""\n'
                    '  try\n'
                    '    set winTitle to name of front window of appProc\n'
                    '  end try\n'
                    '  return appName & "|||" & winTitle\n'
                    'end tell',
                ],
                capture_output=True, text=True, timeout=2,
            )
            parts = result.stdout.strip().split("|||", 1)
            app_name = parts[0].strip() if parts else ""
            window_title = parts[1].strip() if len(parts) > 1 else ""
            return app_name, window_title
        except Exception:
            return "", ""

    def detect_change(self) -> tuple[bool, bool, str, str]:
        """Returns (app_changed, window_changed, app_name, window_title)."""
        app, window = self.get_active_app()
        app_changed = app != self._last_app and self._last_app != ""
        window_changed = window != self._last_window and self._last_window != ""
        self._last_app = app
        self._last_window = window
        return app_changed, window_changed, app, window
