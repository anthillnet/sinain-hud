"""Detect the frontmost application and window title (cross-platform)."""
import subprocess
import sys


class MacAppDetector:
    """Frontmost application + window title on macOS.

    Display-aware: given a display_id, reports the frontmost window ON THAT
    display (via CGWindowList), not the global frontmost. This matters when
    capture is pinned to one display while keyboard focus is on an app on
    ANOTHER screen — the captured content's app must drive ROI app-scoping, or
    eyes on the captured display get wrongly archived (treated as an app switch)
    and new regions get rejected as "foreign". Falls back to AppleScript (global
    frontmost) when Quartz is unavailable or no display_id is supplied.
    """

    def __init__(self):
        self._last_app: str = ""
        self._last_window: str = ""
        try:
            import Quartz  # type: ignore
            self._quartz = Quartz
        except Exception:
            self._quartz = None

    def _frontmost_on_display(self, display_id: int):
        """(app, title) of the frontmost normal window whose center is on the
        given display, or None if it can't be determined."""
        Q = self._quartz
        if Q is None or not display_id:
            return None
        try:
            bounds = Q.CGDisplayBounds(display_id)
            ox, oy = bounds.origin.x, bounds.origin.y
            ow, oh = bounds.size.width, bounds.size.height
            windows = Q.CGWindowListCopyWindowInfo(
                Q.kCGWindowListOptionOnScreenOnly | Q.kCGWindowListExcludeDesktopElements,
                Q.kCGNullWindowID,
            )
            for w in windows:  # returned front-to-back
                if w.get("kCGWindowLayer", 0) != 0:
                    continue  # skip menubar/dock/overlays; 0 == normal app windows
                wb = w.get("kCGWindowBounds")
                if not wb:
                    continue
                cx = wb["X"] + wb["Width"] / 2.0
                cy = wb["Y"] + wb["Height"] / 2.0
                if ox <= cx < ox + ow and oy <= cy < oy + oh:
                    owner = w.get("kCGWindowOwnerName", "") or ""
                    title = w.get("kCGWindowName", "") or ""
                    return owner, title
        except Exception:
            return None
        return None

    def _global_frontmost(self) -> tuple[str, str]:
        """AppleScript fallback — global frontmost app (display-agnostic)."""
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

    def get_active_app(self, display_id: int = 0) -> tuple[str, str]:
        """Returns (app_name, window_title). Prefers the frontmost window on the
        captured display; falls back to the global frontmost."""
        on_display = self._frontmost_on_display(display_id)
        if on_display is not None and on_display[0]:
            return on_display
        return self._global_frontmost()

    def detect_change(self, display_id: int = 0) -> tuple[bool, bool, str, str]:
        """Returns (app_changed, window_changed, app_name, window_title)."""
        app, window = self.get_active_app(display_id)
        app_changed = app != self._last_app and self._last_app != ""
        window_changed = window != self._last_window and self._last_window != ""
        self._last_app = app
        self._last_window = window
        return app_changed, window_changed, app, window


def AppDetector():
    """Factory: returns the platform-appropriate app detector."""
    if sys.platform == "win32":
        from .app_detector_win import WinAppDetector
        return WinAppDetector()
    return MacAppDetector()
