#include "hotkey_handler.h"

#include <flutter/encodable_value.h>

// Hotkey IDs — same as macOS AppDelegate.swift
enum HotkeyId {
  kToggleVisibility = 1,
  kCycleState = 3,
  kQuit = 4,
  kToggleAudio = 5,
  kToggleAudioFeed = 7,
  kScrollUp = 8,
  kScrollDown = 9,
  kToggleScreen = 10,
  kToggleScreenFeed = 11,
  kCycleTab = 12,
  kResetPosition = 13,
  kCopyMessage = 14,
  kTogglePrivacy = 15,
  kToggleTraits = 17,
  kFocusInput = 18,
  kToggleChat = 19,
};

// HUD layout constants (for position toggle)
static constexpr int kHudWidth = 427;
static constexpr int kHudHeight = 293;
static constexpr int kHudMargin = 16;

HotkeyHandler* HotkeyHandler::instance_ = nullptr;

HotkeyHandler* HotkeyHandler::GetInstance() {
  if (!instance_) {
    instance_ = new HotkeyHandler();
  }
  return instance_;
}

void HotkeyHandler::Initialize(flutter::FlutterEngine* engine, HWND hwnd) {
  hwnd_ = hwnd;
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      engine->messenger(), "sinain_hud/hotkeys",
      &flutter::StandardMethodCodec::GetInstance());
}

void HotkeyHandler::RegisterHotkeys() {
  if (!hwnd_) return;

  // All hotkeys use Ctrl+Shift (Windows equivalent of Cmd+Shift on macOS).
  // MOD_NOREPEAT prevents repeated WM_HOTKEY when held down.
  UINT mod = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;

  // Failures are non-fatal — hotkey may be registered by another app.
  RegisterHotKey(hwnd_, kToggleVisibility, mod, VK_SPACE);
  RegisterHotKey(hwnd_, kCycleState,       mod, 'M');
  RegisterHotKey(hwnd_, kQuit,             mod, 'H');
  RegisterHotKey(hwnd_, kToggleChat,       mod, 'F');
  RegisterHotKey(hwnd_, kToggleAudio,      mod, 'T');
  RegisterHotKey(hwnd_, kToggleAudioFeed,  mod, 'A');
  RegisterHotKey(hwnd_, kScrollUp,         mod, VK_UP);
  RegisterHotKey(hwnd_, kScrollDown,       mod, VK_DOWN);
  RegisterHotKey(hwnd_, kToggleScreen,     mod, 'S');
  RegisterHotKey(hwnd_, kToggleScreenFeed, mod, 'V');
  RegisterHotKey(hwnd_, kCycleTab,         mod, 'E');
  RegisterHotKey(hwnd_, kResetPosition,    mod, 'P');
  RegisterHotKey(hwnd_, kCopyMessage,      mod, 'Y');
  RegisterHotKey(hwnd_, kTogglePrivacy,    mod, 'R');
  RegisterHotKey(hwnd_, kToggleTraits,     mod, 'B');
  RegisterHotKey(hwnd_, kFocusInput,       mod, VK_OEM_2);  // '/' key
}

void HotkeyHandler::UnregisterHotkeys() {
  if (!hwnd_) return;
  int ids[] = {1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19};
  for (int id : ids) {
    UnregisterHotKey(hwnd_, id);
  }
}

void HotkeyHandler::ProcessHotkey(int id) {
  if (!channel_) return;

  switch (id) {
    case kToggleVisibility: {
      is_visible_ = !is_visible_;
      if (is_visible_) {
        ::ShowWindow(hwnd_, SW_SHOWNA);
      } else {
        ::ShowWindow(hwnd_, SW_HIDE);
      }
      InvokeMethod("onToggleVisibility", is_visible_);
      break;
    }

    case kCycleState:
      InvokeMethod("onCycleState");
      break;

    case kQuit: {
      InvokeMethod("onQuit");
      // Give Flutter 300ms to clean up, then exit
      SetTimer(hwnd_, 9999, 300, [](HWND hwnd, UINT, UINT_PTR id, DWORD) {
        KillTimer(hwnd, id);
        PostQuitMessage(0);
      });
      break;
    }

    case kToggleAudio:
      InvokeMethod("onToggleAudio");
      break;

    case kToggleAudioFeed:
      InvokeMethod("onToggleAudioFeed");
      break;

    case kScrollUp:
      InvokeMethod("onScrollFeed", std::string("up"));
      break;

    case kScrollDown:
      InvokeMethod("onScrollFeed", std::string("down"));
      break;

    case kToggleScreen:
      InvokeMethod("onToggleScreen");
      break;

    case kToggleScreenFeed:
      InvokeMethod("onToggleScreenFeed");
      break;

    case kCycleTab:
      InvokeMethod("onCycleTab");
      break;

    case kResetPosition:
      InvokeMethod("onResetPosition");
      break;

    case kCopyMessage:
      InvokeMethod("onCopyMessage");
      break;

    case kTogglePrivacy: {
      // Toggle WDA_EXCLUDEFROMCAPTURE
      typedef BOOL(WINAPI * GetWindowDisplayAffinityFunc)(HWND, DWORD*);
      typedef BOOL(WINAPI * SetWindowDisplayAffinityFunc)(HWND, DWORD);
      static auto get_fn = reinterpret_cast<GetWindowDisplayAffinityFunc>(
          GetProcAddress(GetModuleHandle(L"user32.dll"), "GetWindowDisplayAffinity"));
      static auto set_fn = reinterpret_cast<SetWindowDisplayAffinityFunc>(
          GetProcAddress(GetModuleHandle(L"user32.dll"), "SetWindowDisplayAffinity"));
      if (get_fn && set_fn) {
        DWORD current = 0;
        get_fn(hwnd_, &current);
        bool is_private = (current == 0x00000011);
        set_fn(hwnd_, is_private ? WDA_NONE : 0x00000011);
        InvokeMethod("onTogglePrivacy", !is_private);
      }
      break;
    }

    case kToggleTraits:
      InvokeMethod("onToggleTraits");
      break;

    case kFocusInput:
      InvokeMethod("onFocusInput");
      break;

    case kToggleChat:
      InvokeMethod("onToggleChat");
      break;
  }
}

// ── Channel invocation helpers ─────────────────────────────────────────────

void HotkeyHandler::InvokeMethod(const std::string& method) {
  channel_->InvokeMethod(method, nullptr);
}

void HotkeyHandler::InvokeMethod(const std::string& method, bool value) {
  channel_->InvokeMethod(method,
      std::make_unique<flutter::EncodableValue>(value));
}

void HotkeyHandler::InvokeMethod(const std::string& method,
                                  const std::string& value) {
  channel_->InvokeMethod(method,
      std::make_unique<flutter::EncodableValue>(value));
}
