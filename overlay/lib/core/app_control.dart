import 'dart:io';

import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

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

/// Open the active backend log. Returns null on success, otherwise a short
/// user-facing reason that can be surfaced in the chat alert banner.
Future<String?> openCurrentSessionLog() async {
  String? nativeError;
  try {
    final opened = await const MethodChannel(
      'sinain_hud/backend',
    ).invokeMethod<dynamic>('openLog');
    if (opened == true) return null;
    if (opened is Map) {
      if (opened['opened'] == true) return null;
      final path = opened['path']?.toString();
      final error = opened['error']?.toString();
      nativeError = [
        if (error != null && error.isNotEmpty) error,
        if (path != null && path.isNotEmpty) path,
      ].join(' ');
    }
  } catch (e) {
    // Missing channel in dev/Windows builds is fine; use the filesystem path.
    nativeError = e.toString();
  }

  final path = _defaultSessionLogPath();
  if (path == null) {
    return 'Session log path is not available on this platform.';
  }
  final file = File(path);
  if (!await file.exists()) {
    return nativeError == null || nativeError.isEmpty
        ? 'Session log not found: $path'
        : 'Could not open session log: $nativeError';
  }
  final uri = file.uri;
  try {
    if (await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      return null;
    }
  } catch (e) {
    return 'Could not open session log: $e';
  }
  return 'Could not open session log: $path';
}

String? _defaultSessionLogPath() {
  if (Platform.isMacOS || Platform.isLinux) {
    final sessionLog = Platform.environment['SINAIN_SESSION_LOG'];
    if (sessionLog != null && sessionLog.isNotEmpty) return sessionLog;
    final home = Platform.environment['HOME'];
    return home == null ? null : '$home/.sinain/logs/backend.log';
  }
  if (Platform.isWindows) {
    final sessionLog = Platform.environment['SINAIN_SESSION_LOG'];
    if (sessionLog != null && sessionLog.isNotEmpty) return sessionLog;
    final appData = Platform.environment['APPDATA'];
    return appData == null ? null : '$appData\\sinain\\logs\\core.log';
  }
  return null;
}
