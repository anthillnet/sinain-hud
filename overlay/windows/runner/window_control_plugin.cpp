#include "window_control_plugin.h"

#include <dwmapi.h>
#include <flutter/encodable_value.h>

// WDA_EXCLUDEFROMCAPTURE — Windows 10 2004+ (build 19041)
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

// HUD layout constants (matching macOS HUDConfig.swift)
static constexpr int kHudWidth = 427;
static constexpr int kHudHeight = 293;
static constexpr int kHudMargin = 16;

WindowControlPlugin::WindowControlPlugin(HWND hwnd) : hwnd_(hwnd) {}

void WindowControlPlugin::Register(flutter::FlutterEngine* engine, HWND hwnd) {
  auto channel = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      engine->messenger(), "sinain_hud/window",
      &flutter::StandardMethodCodec::GetInstance());

  auto plugin = std::make_unique<WindowControlPlugin>(hwnd);
  auto* plugin_ptr = plugin.get();

  channel->SetMethodCallHandler(
      [plugin_ptr](const auto& call, auto result) {
        plugin_ptr->HandleMethodCall(call, std::move(result));
      });

  // prevent unique_ptr from deleting — channel ref captures plugin_ptr
  plugin.release();
}

void WindowControlPlugin::HandleMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {

  const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());

  if (call.method_name() == "setPrivacyMode") {
    bool enabled = true;
    if (args) {
      auto it = args->find(flutter::EncodableValue("enabled"));
      if (it != args->end()) {
        enabled = std::get<bool>(it->second);
      }
    }
    SetPrivacyMode(enabled);
    result->Success();

  } else if (call.method_name() == "setClickThrough") {
    bool enabled = true;
    if (args) {
      auto it = args->find(flutter::EncodableValue("enabled"));
      if (it != args->end()) {
        enabled = std::get<bool>(it->second);
      }
    }
    SetClickThrough(enabled);
    result->Success();

  } else if (call.method_name() == "setAlwaysOnTop") {
    bool enabled = true;
    if (args) {
      auto it = args->find(flutter::EncodableValue("enabled"));
      if (it != args->end()) {
        enabled = std::get<bool>(it->second);
      }
    }
    SetAlwaysOnTop(enabled);
    result->Success();

  } else if (call.method_name() == "setTransparent") {
    SetTransparent();
    result->Success();

  } else if (call.method_name() == "hideWindow") {
    HideWindow();
    result->Success();

  } else if (call.method_name() == "showWindow") {
    ShowWindowNA();
    result->Success();

  } else if (call.method_name() == "setPosition") {
    bool top = false;
    if (args) {
      auto it = args->find(flutter::EncodableValue("top"));
      if (it != args->end()) {
        top = std::get<bool>(it->second);
      }
    }
    SetPosition(top);
    result->Success();

  } else if (call.method_name() == "activateCommandInput") {
    ActivateCommandInput();
    result->Success();

  } else if (call.method_name() == "dismissCommandInput") {
    DismissCommandInput();
    result->Success();

  } else {
    result->NotImplemented();
  }
}

// ── Win32 implementations ──────────────────────────────────────────────────

void WindowControlPlugin::SetPrivacyMode(bool enabled) {
  // Dynamically load SetWindowDisplayAffinity for graceful fallback
  // on Windows versions older than 10 2004.
  typedef BOOL(WINAPI * SetWindowDisplayAffinityFunc)(HWND, DWORD);
  static auto fn = reinterpret_cast<SetWindowDisplayAffinityFunc>(
      GetProcAddress(GetModuleHandle(L"user32.dll"), "SetWindowDisplayAffinity"));
  if (fn) {
    fn(hwnd_, enabled ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
  }
}

void WindowControlPlugin::SetClickThrough(bool enabled) {
  click_through_ = enabled;
  LONG_PTR ex_style = GetWindowLongPtr(hwnd_, GWL_EXSTYLE);
  if (enabled) {
    ex_style |= WS_EX_TRANSPARENT;
  } else {
    ex_style &= ~WS_EX_TRANSPARENT;
  }
  SetWindowLongPtr(hwnd_, GWL_EXSTYLE, ex_style);
}

void WindowControlPlugin::SetAlwaysOnTop(bool enabled) {
  SetWindowPos(hwnd_,
               enabled ? HWND_TOPMOST : HWND_NOTOPMOST,
               0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

void WindowControlPlugin::SetTransparent() {
  // Enable layered window for per-pixel alpha
  LONG_PTR ex_style = GetWindowLongPtr(hwnd_, GWL_EXSTYLE);
  ex_style |= WS_EX_LAYERED;
  SetWindowLongPtr(hwnd_, GWL_EXSTYLE, ex_style);

  // Full alpha — Flutter handles per-pixel transparency
  SetLayeredWindowAttributes(hwnd_, 0, 255, LWA_ALPHA);

  // Extend DWM frame into entire client area for glass-through transparency
  MARGINS margins = {-1, -1, -1, -1};
  DwmExtendFrameIntoClientArea(hwnd_, &margins);
}

void WindowControlPlugin::HideWindow() {
  ::ShowWindow(hwnd_, SW_HIDE);
}

void WindowControlPlugin::ShowWindowNA() {
  // SW_SHOWNA = show without activating (don't steal focus)
  ::ShowWindow(hwnd_, SW_SHOWNA);
}

void WindowControlPlugin::SetPosition(bool top) {
  RECT work_area;
  SystemParametersInfo(SPI_GETWORKAREA, 0, &work_area, 0);

  int x = work_area.right - kHudWidth - kHudMargin;
  int y = top
      ? work_area.top + kHudMargin
      : work_area.bottom - kHudHeight - kHudMargin;

  SetWindowPos(hwnd_, nullptr, x, y, kHudWidth, kHudHeight,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void WindowControlPlugin::ActivateCommandInput() {
  // Remove click-through so the window receives mouse/keyboard events
  SetClickThrough(false);

  // Bring to foreground — AttachThreadInput workaround for foreground lock
  DWORD fore_thread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
  DWORD this_thread = GetCurrentThreadId();
  if (fore_thread != this_thread) {
    AttachThreadInput(fore_thread, this_thread, TRUE);
    SetForegroundWindow(hwnd_);
    AttachThreadInput(fore_thread, this_thread, FALSE);
  } else {
    SetForegroundWindow(hwnd_);
  }
  SetFocus(hwnd_);
}

void WindowControlPlugin::DismissCommandInput() {
  // Restore click-through
  SetClickThrough(true);
}
