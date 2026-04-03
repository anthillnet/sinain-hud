import 'dart:async';
import 'package:flutter/services.dart';

/// Platform channel wrapper for the native Swift WindowControlPlugin.
class WindowService {
  static const _channel = MethodChannel('sinain_hud/window');

  final _regionTapController = StreamController<String>.broadcast();
  /// Stream of region IDs tapped by user (from native eye windows).
  Stream<String> get regionTapStream => _regionTapController.stream;

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

  /// Move window by delta (screen points). Synchronous native call — no frame fetch needed.
  Future<void> moveWindowBy(double dx, double dy) async {
    try {
      await _channel.invokeMethod('moveWindowBy', {'dx': dx, 'dy': dy});
    } catch (e) {
      _log('moveWindowBy failed: $e');
    }
  }

  /// Delta-based resize with anchor control. No async frame fetch needed.
  Future<void> resizeWindowBy(double dw, double dh, {bool anchorRight = false, bool anchorTop = false}) async {
    try {
      await _channel.invokeMethod('resizeWindowBy', {
        'dw': dw,
        'dh': dh,
        'anchorRight': anchorRight,
        'anchorTop': anchorTop,
      });
    } catch (e) {
      _log('resizeWindowBy failed: $e');
    }
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

  // ── Region Window Pool (Grammarly mode) ──

  /// Create a small eye window at screen coordinates.
  Future<void> createRegionWindow(String id, double x, double y) async {
    try {
      _log('createRegionWindow id=$id x=$x y=$y');
      await _channel.invokeMethod('createRegionWindow', {'id': id, 'x': x, 'y': y});
    } catch (e) {
      _log('createRegionWindow failed: $e');
    }
  }

  /// Remove a specific region window.
  Future<void> removeRegionWindow(String id) async {
    try {
      _log('removeRegionWindow id=$id');
      await _channel.invokeMethod('removeRegionWindow', {'id': id});
    } catch (e) {
      _log('removeRegionWindow failed: $e');
    }
  }

  /// Remove all region windows.
  Future<void> removeAllRegionWindows() async {
    try {
      _log('removeAllRegionWindows');
      await _channel.invokeMethod('removeAllRegionWindows');
    } catch (e) {
      _log('removeAllRegionWindows failed: $e');
    }
  }

  /// Reset window to default position (bottom-right corner, eye size).
  Future<void> resetToDefaultPosition() async {
    try {
      await _channel.invokeMethod('resetToDefaultPosition');
    } catch (e) {
      _log('resetToDefaultPosition failed: $e');
    }
  }

  /// Open a file in the system default editor.
  Future<void> openFile(String path) async {
    try {
      await _channel.invokeMethod('openFile', {'path': path});
    } catch (e) {
      _log('openFile failed: $e');
    }
  }

  /// Start native drag tracking (macOS only). Native handles all mouse events
  /// and calls back onNativeDragComplete when done.
  Future<void> beginNativeDrag() async {
    try {
      await _channel.invokeMethod('beginNativeDrag');
    } catch (e) {
      _log('beginNativeDrag failed: $e');
    }
  }

  /// Start native resize tracking (macOS only).
  Future<void> beginNativeResize(String edge) async {
    try {
      await _channel.invokeMethod('beginNativeResize', {'edge': edge});
    } catch (e) {
      _log('beginNativeResize failed: $e');
    }
  }

  /// Register callbacks for native drag/resize completion (macOS).
  /// Native sends final position/size on mouse-up.
  void setupNativeCallbacks({
    required void Function(double x, double y) onDragDone,
    required void Function(double w, double h) onResizeDone,
  }) {
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'onNativeDragComplete':
          final args = call.arguments as Map;
          onDragDone(
            (args['x'] as num).toDouble(),
            (args['y'] as num).toDouble(),
          );
        case 'onNativeResizeComplete':
          final args = call.arguments as Map;
          onResizeDone(
            (args['w'] as num).toDouble(),
            (args['h'] as num).toDouble(),
          );
        case 'onRegionTap':
          final args = call.arguments as Map;
          final id = args['id'] as String? ?? '';
          _log('onRegionTap callback: id=$id');
          _regionTapController.add(id);
      }
    });
  }

  void _log(String msg) {
    // ignore: avoid_print
    print('[WindowService] $msg');
  }
}
