#ifndef RUNNER_HOTKEY_HANDLER_H_
#define RUNNER_HOTKEY_HANDLER_H_

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <flutter/flutter_engine.h>
#include <windows.h>

#include <memory>
#include <string>
#include <vector>

// Global hotkey handler for sinain_hud/hotkeys platform channel.
// Mirrors the macOS AppDelegate.swift hotkey system — same IDs and Dart method names.
// Uses Ctrl+Shift on Windows (instead of Cmd+Shift on macOS).
class HotkeyHandler {
 public:
  static HotkeyHandler* GetInstance();

  void Initialize(flutter::FlutterEngine* engine, HWND hwnd);
  void RegisterHotkeys();
  void UnregisterHotkeys();

  // Called from WndProc on WM_HOTKEY
  void ProcessHotkey(int id);

 private:
  HotkeyHandler() = default;

  void InvokeMethod(const std::string& method);
  void InvokeMethod(const std::string& method, bool value);
  void InvokeMethod(const std::string& method, const std::string& value);

  static HotkeyHandler* instance_;

  HWND hwnd_ = nullptr;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;

  // State tracking (mirrors AppDelegate.swift)
  bool is_visible_ = true;
};

#endif  // RUNNER_HOTKEY_HANDLER_H_
