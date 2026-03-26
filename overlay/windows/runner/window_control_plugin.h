#ifndef RUNNER_WINDOW_CONTROL_PLUGIN_H_
#define RUNNER_WINDOW_CONTROL_PLUGIN_H_

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <flutter/flutter_engine.h>
#include <windows.h>

// Platform channel implementation for sinain_hud/window.
// Mirrors the macOS WindowControlPlugin.swift — same method names and args.
class WindowControlPlugin {
 public:
  static void Register(flutter::FlutterEngine* engine, HWND hwnd);
  WindowControlPlugin(HWND hwnd);

 private:

  void HandleMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  // Win32 helpers
  void SetPrivacyMode(bool enabled);
  void SetClickThrough(bool enabled);
  void SetAlwaysOnTop(bool enabled);
  void SetTransparent();
  void HideWindow();
  void ShowWindowNA();
  void SetPosition(bool top);
  void ActivateCommandInput();
  void DismissCommandInput();

  // New methods (parity with macOS WindowControlPlugin)
  void SetWindowFrame(double x, double y, double w, double h);
  void MoveWindowBy(double dx, double dy);
  void ResizeWindowBy(double dw, double dh, bool anchor_right, bool anchor_top);
  void ResetToDefaultPosition();
  void OpenFile(const std::string& path);

  HWND hwnd_;
  bool click_through_ = true;
};

#endif  // RUNNER_WINDOW_CONTROL_PLUGIN_H_
