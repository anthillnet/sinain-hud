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

  Future<void> setClickThrough(bool enabled) async {
    try {
      await _channel.invokeMethod('setClickThrough', {'enabled': enabled});
    } catch (e) {
      _log('setClickThrough failed: $e');
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

  Future<void> setPosition({required bool top}) async {
    try {
      await _channel.invokeMethod('setPosition', {'top': top});
    } catch (e) {
      _log('setPosition failed: $e');
    }
  }

  /// Activate command input: disable click-through and make key window.
  Future<void> activateCommandInput() async {
    try {
      await _channel.invokeMethod('activateCommandInput');
    } catch (e) {
      _log('activateCommandInput failed: $e');
    }
  }

  /// Dismiss command input: restore click-through and resign key window.
  Future<void> dismissCommandInput() async {
    try {
      await _channel.invokeMethod('dismissCommandInput');
    } catch (e) {
      _log('dismissCommandInput failed: $e');
    }
  }

  void _log(String msg) {
    // ignore: avoid_print
    print('[WindowService] $msg');
  }
}
