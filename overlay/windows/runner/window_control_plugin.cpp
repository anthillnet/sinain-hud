#include "window_control_plugin.h"

#include <algorithm>
#include <dwmapi.h>
#include <shellapi.h>
#include <flutter/encodable_value.h>

// WDA_EXCLUDEFROMCAPTURE — Windows 10 2004+ (build 19041)
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

// HUD layout constants (matching macOS HUDConfig.swift)
static constexpr int kEyeSize = 48;
static constexpr int kHudWidth = 427;
static constexpr int kHudHeight = 293;
static constexpr int kHudMargin = 16;
static constexpr int kMinChatWidth = 300;
static constexpr int kMinChatHeight = 200;
static constexpr int kMaxChatWidth = 800;
static constexpr int kMaxChatHeight = 900;

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

  } else if (call.method_name() == "activateCommandInput" ||
             call.method_name() == "makeKeyWindow") {
    ActivateCommandInput();
    result->Success();

  } else if (call.method_name() == "dismissCommandInput" ||
             call.method_name() == "resignKeyWindow") {
    DismissCommandInput();
    result->Success();

  } else if (call.method_name() == "setWindowFrame") {
    double x = 0, y = 0, w = kEyeSize, h = kEyeSize;
    if (args) {
      auto ix = args->find(flutter::EncodableValue("x"));
      auto iy = args->find(flutter::EncodableValue("y"));
      auto iw = args->find(flutter::EncodableValue("w"));
      auto ih = args->find(flutter::EncodableValue("h"));
      if (ix != args->end()) x = std::get<double>(ix->second);
      if (iy != args->end()) y = std::get<double>(iy->second);
      if (iw != args->end()) w = std::get<double>(iw->second);
      if (ih != args->end()) h = std::get<double>(ih->second);
    }
    SetWindowFrame(x, y, w, h);
    result->Success();

  } else if (call.method_name() == "getWindowFrame") {
    RECT rect;
    GetWindowRect(hwnd_, &rect);
    flutter::EncodableMap map;
    map[flutter::EncodableValue("x")] = flutter::EncodableValue(static_cast<double>(rect.left));
    map[flutter::EncodableValue("y")] = flutter::EncodableValue(static_cast<double>(rect.top));
    map[flutter::EncodableValue("w")] = flutter::EncodableValue(static_cast<double>(rect.right - rect.left));
    map[flutter::EncodableValue("h")] = flutter::EncodableValue(static_cast<double>(rect.bottom - rect.top));
    result->Success(flutter::EncodableValue(map));

  } else if (call.method_name() == "moveWindowBy") {
    double dx = 0, dy = 0;
    if (args) {
      auto idx = args->find(flutter::EncodableValue("dx"));
      auto idy = args->find(flutter::EncodableValue("dy"));
      if (idx != args->end()) dx = std::get<double>(idx->second);
      if (idy != args->end()) dy = std::get<double>(idy->second);
    }
    MoveWindowBy(dx, dy);
    result->Success();

  } else if (call.method_name() == "resizeWindowBy") {
    double dw = 0, dh = 0;
    bool anchor_right = false, anchor_top = false;
    if (args) {
      auto idw = args->find(flutter::EncodableValue("dw"));
      auto idh = args->find(flutter::EncodableValue("dh"));
      auto iar = args->find(flutter::EncodableValue("anchorRight"));
      auto iat = args->find(flutter::EncodableValue("anchorTop"));
      if (idw != args->end()) dw = std::get<double>(idw->second);
      if (idh != args->end()) dh = std::get<double>(idh->second);
      if (iar != args->end()) anchor_right = std::get<bool>(iar->second);
      if (iat != args->end()) anchor_top = std::get<bool>(iat->second);
    }
    ResizeWindowBy(dw, dh, anchor_right, anchor_top);
    result->Success();

  } else if (call.method_name() == "resetToDefaultPosition") {
    ResetToDefaultPosition();
    result->Success();

  } else if (call.method_name() == "openFile") {
    std::string path;
    if (args) {
      auto it = args->find(flutter::EncodableValue("path"));
      if (it != args->end()) path = std::get<std::string>(it->second);
    }
    if (!path.empty()) OpenFile(path);
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

void WindowControlPlugin::SetWindowFrame(double x, double y, double w, double h) {
  SetWindowPos(hwnd_, nullptr,
               static_cast<int>(x), static_cast<int>(y),
               static_cast<int>(w), static_cast<int>(h),
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void WindowControlPlugin::MoveWindowBy(double dx, double dy) {
  RECT rect;
  GetWindowRect(hwnd_, &rect);
  // Windows Y-axis is top-down (same as Flutter), so no inversion needed
  SetWindowPos(hwnd_, nullptr,
               rect.left + static_cast<int>(dx),
               rect.top + static_cast<int>(dy),
               0, 0,
               SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
}

void WindowControlPlugin::ResizeWindowBy(double dw, double dh,
                                          bool anchor_right, bool anchor_top) {
  RECT rect;
  GetWindowRect(hwnd_, &rect);
  int old_w = rect.right - rect.left;
  int old_h = rect.bottom - rect.top;

  int new_w = std::clamp(old_w + static_cast<int>(dw), kMinChatWidth, kMaxChatWidth);
  int new_h = std::clamp(old_h + static_cast<int>(dh), kMinChatHeight, kMaxChatHeight);

  int x = rect.left;
  int y = rect.top;

  // Anchor adjustments: keep the specified edge fixed
  if (anchor_right) {
    x += (old_w - new_w);
  }
  if (!anchor_top) {
    // Default: keep bottom edge fixed. On Windows (Y top-down), bottom = y + h.
    // To keep bottom fixed: new_y = old_y + (old_h - new_h)
    y += (old_h - new_h);
  }
  // If anchor_top: Y stays the same (top-down origin), no adjustment needed.

  SetWindowPos(hwnd_, nullptr, x, y, new_w, new_h,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void WindowControlPlugin::ResetToDefaultPosition() {
  RECT work_area;
  SystemParametersInfo(SPI_GETWORKAREA, 0, &work_area, 0);
  int x = work_area.right - kEyeSize - kHudMargin;
  int y = work_area.bottom - kEyeSize - kHudMargin;
  SetWindowPos(hwnd_, nullptr, x, y, kEyeSize, kEyeSize,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

void WindowControlPlugin::OpenFile(const std::string& path) {
  // Convert UTF-8 path to wide string
  int len = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  std::wstring wpath(len, 0);
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wpath[0], len);
  ShellExecuteW(nullptr, L"open", wpath.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}
