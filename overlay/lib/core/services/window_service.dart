import 'package:flutter/services.dart';

/// Platform channel wrapper for the native Swift WindowControlPlugin.
class WindowService {
  static const _channel = MethodChannel('sinain_hud/window');

  Future<void> setTransparent() async {
    try {
      await _channel.invokeMethod('setTransparent');
    } catch (e) {
      _log('setTransparent failed: $e');
    }
  }

  Future<void> setPrivacyMode(bool enabled) async {
    try {
      await _channel.invokeMethod('setPrivacyMode', {'enabled': enabled});
    } catch (e) {
      _log('setPrivacyMode failed: $e');
    }
  }

  Future<void> setAlwaysOnTop(bool enabled) async {
    try {
      await _channel.invokeMethod('setAlwaysOnTop', {'enabled': enabled});
    } catch (e) {
      _log('setAlwaysOnTop failed: $e');
    }
  }

  Future<void> hideWindow() async {
    try {
      await _channel.invokeMethod('hideWindow');
    } catch (e) {
      _log('hideWindow failed: $e');
    }
  }

  Future<void> showWindow() async {
    try {
      await _channel.invokeMethod('showWindow');
    } catch (e) {
      _log('showWindow failed: $e');
    }
  }

  /// Set the window frame (position + size).
  Future<void> setWindowFrame(double x, double y, double w, double h) async {
    try {
      await _channel.invokeMethod('setWindowFrame', {
        'x': x,
        'y': y,
        'w': w,
        'h': h,
      });
    } catch (e) {
      _log('setWindowFrame failed: $e');
    }
  }

  /// Get the current window frame.
  Future<Map<String, double>?> getWindowFrame() async {
    try {
      final result = await _channel.invokeMethod('getWindowFrame');
      if (result is Map) {
        return {
          'x': (result['x'] as num).toDouble(),
          'y': (result['y'] as num).toDouble(),
          'w': (result['w'] as num).toDouble(),
          'h': (result['h'] as num).toDouble(),
        };
      }
    } catch (e) {
      _log('getWindowFrame failed: $e');
    }
    return null;
  }

  /// Make the panel the key window (for text input in chat state).
  Future<void> makeKeyWindow() async {
    try {
      await _channel.invokeMethod('makeKeyWindow');
    } catch (e) {
      _log('makeKeyWindow failed: $e');
    }
  }

  /// Resign key window status (return focus to previous app).
  Future<void> resignKeyWindow() async {
    try {
      await _channel.invokeMethod('resignKeyWindow');
    } catch (e) {
      _log('resignKeyWindow failed: $e');
    }
  }

  void _log(String msg) {
    // ignore: avoid_print
    print('[WindowService] $msg');
  }
}
