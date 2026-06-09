import 'dart:io';

import 'package:flutter/services.dart';

/// Quit the whole app (overlay + bundled backend). Routes through the native
/// backend channel so AppDelegate.applicationWillTerminate runs and SIGTERMs
/// the bundled backend; falls back to a hard exit if the channel is absent
/// (e.g. an unexpected platform).
Future<void> quitApp() async {
  try {
    await const MethodChannel('sinain_hud/backend').invokeMethod('quit');
  } catch (_) {
    exit(0);
  }
}
