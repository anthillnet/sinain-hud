import 'package:flutter/services.dart';

/// Platform channel wrapper for the native Swift WindowControlPlugin.
class WindowService {
  static const _channel = MethodChannel('sinain_hud/window');

  Future<void> setTransparent() async {
    try {
      await _channel.invokeMethod('setTransparent');
    } on PlatformException catch (e) {
      _log('setTransparent failed: $e');
    }
  }

  Future<void> setPrivacyMode(bool enabled) async {
    try {
      await _channel.invokeMethod('setPrivacyMode', {'enabled': enabled});
    } on PlatformException catch (e) {
      _log('setPrivacyMode failed: $e');
    }
  }

  Future<void> setClickThrough(bool enabled) async {
    try {
      await _channel.invokeMethod('setClickThrough', {'enabled': enabled});
    } on PlatformException catch (e) {
      _log('setClickThrough failed: $e');
    }
  }

  Future<void> setAlwaysOnTop(bool enabled) async {
    try {
      await _channel.invokeMethod('setAlwaysOnTop', {'enabled': enabled});
    } on PlatformException catch (e) {
      _log('setAlwaysOnTop failed: $e');
    }
  }

  Future<void> hideWindow() async {
    try {
      await _channel.invokeMethod('hideWindow');
    } on PlatformException catch (e) {
      _log('hideWindow failed: $e');
    }
  }

  Future<void> showWindow() async {
    try {
      await _channel.invokeMethod('showWindow');
    } on PlatformException catch (e) {
      _log('showWindow failed: $e');
    }
  }

  void _log(String msg) {
    // ignore: avoid_print
    print('[WindowService] $msg');
  }
}
