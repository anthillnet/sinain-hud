"""Detect the foreground application and window title on Windows."""
from __future__ import annotations

import ctypes
import ctypes.wintypes


class WinAppDetector:
    """Detects the foreground application and window title on Windows.

    Uses Win32 API: GetForegroundWindow, GetWindowTextW, and
    psutil/GetWindowThreadProcessId for process name resolution.
    """

    def __init__(self):
        self._last_app: str = ""
        self._last_window: str = ""
        self._user32 = ctypes.windll.user32
        self._kernel32 = ctypes.windll.kernel32

    def get_active_app(self) -> tuple[str, str]:
        """Returns (app_name, window_title) of the foreground window."""
        try:
            hwnd = self._user32.GetForegroundWindow()
            if not hwnd:
                return "", ""

            # Get window title
            length = self._user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(length + 1)
            self._user32.GetWindowTextW(hwnd, buf, length + 1)
            window_title = buf.value

            # Get process name via PID
            pid = ctypes.wintypes.DWORD()
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            app_name = self._get_process_name(pid.value)

            return app_name, window_title
        except Exception:
            return "", ""

    def _get_process_name(self, pid: int) -> str:
        """Get process executable name from PID."""
        try:
            # Try psutil first (more reliable)
            import psutil
            proc = psutil.Process(pid)
            return proc.name().replace(".exe", "")
        except Exception:
            pass

        # Fallback: OpenProcess + GetModuleBaseNameW
        try:
            PROCESS_QUERY_INFORMATION = 0x0400
            PROCESS_VM_READ = 0x0010
            handle = self._kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
            )
            if not handle:
                return ""

            try:
                psapi = ctypes.windll.psapi
                buf = ctypes.create_unicode_buffer(260)
                psapi.GetModuleBaseNameW(handle, None, buf, 260)
                name = buf.value
                if name.lower().endswith(".exe"):
                    name = name[:-4]
                return name
            finally:
                self._kernel32.CloseHandle(handle)
        except Exception:
            return ""

    def detect_change(self) -> tuple[bool, bool, str, str]:
        """Returns (app_changed, window_changed, app_name, window_title)."""
        app, window = self.get_active_app()
        app_changed = app != self._last_app and self._last_app != ""
        window_changed = window != self._last_window and self._last_window != ""
        self._last_app = app
        self._last_window = window
        return app_changed, window_changed, app, window
