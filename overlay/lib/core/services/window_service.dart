import 'dart:async';
import 'package:flutter/services.dart';

/// Platform channel wrapper for the native Swift WindowControlPlugin.
class WindowService {
  static const _channel = MethodChannel('sinain_hud/window');

  final _regionTapController = StreamController<String>.broadcast();

  /// Region eye taps from native panels (Grammarly mode). Emits region ids.
  Stream<String> get regionTapStream => _regionTapController.stream;

  final _regionCardActionController =
      StreamController<(String, String)>.broadcast();

  /// Chat/Term button taps from the native ROI suggestion card. Emits
  /// (regionId, action) where action is 'chat' | 'term'.
  Stream<(String, String)> get regionCardActionStream =>
      _regionCardActionController.stream;

  Future<void> setTransparent() async {
    try {
      await _channel.invokeMethod('setTransparent');
    } catch (e) {
      _log('setTransparent failed: $e');
    }
  }

  /// Browser-style login owned by the app: opens a native WKWebView window on
  /// [url]; resolves with "name=value" once [cookieName] appears in our cookie
  /// store (login completed), or null if the user closes the window.
  Future<String?> openAuthWindow(String url, String cookieName) async {
    try {
      return await _channel.invokeMethod<String>(
          'openAuthWindow', {'url': url, 'cookieName': cookieName});
    } catch (e) {
      _log('openAuthWindow failed: $e');
      return null;
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

  /// Show or hide the Dock icon (and app menu bar) live by flipping the
  /// NSApplication activation policy (.regular ↔ .accessory). macOS only.
  Future<void> setDockIconVisible(bool visible) async {
    try {
      await _channel.invokeMethod('setDockIconVisible', {'visible': visible});
    } catch (e) {
      _log('setDockIconVisible failed: $e');
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

  /// Pop a native right-click context menu at the cursor. [items] is a list of
  /// maps: {id, title, key?, mods?, enabled?} or {separator: true}. Returns the
  /// selected item's id, or null if dismissed.
  Future<String?> showContextMenu(List<Map<String, dynamic>> items) async {
    try {
      final id = await _channel.invokeMethod('showContextMenu', {'items': items});
      return id as String?;
    } catch (e) {
      _log('showContextMenu failed: $e');
      return null;
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

  // ── Screen Recording permission (first-run wizard, Section B) ──

  /// Current Screen Recording grant — non-prompting. Drives the wizard's
  /// "Waiting for grant" poll. False on any platform without the native check.
  Future<bool> screenRecordingStatus() async {
    try {
      final granted = await _channel.invokeMethod('screenRecordingStatus');
      return granted == true;
    } catch (e) {
      _log('screenRecordingStatus failed: $e');
      return false;
    }
  }

  /// Trigger the macOS Screen Recording prompt (no-op once granted). Returns
  /// whether access is already granted at call time.
  Future<bool> requestScreenRecording() async {
    try {
      final granted = await _channel.invokeMethod('requestScreenRecording');
      return granted == true;
    } catch (e) {
      _log('requestScreenRecording failed: $e');
      return false;
    }
  }

  /// Deep-link to System Settings → Privacy & Security → Screen Recording.
  Future<void> openScreenRecordingSettings() async {
    try {
      await _channel.invokeMethod('openScreenRecordingSettings');
    } catch (e) {
      _log('openScreenRecordingSettings failed: $e');
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
          final id = args['id'] as String?;
          if (id != null && id.isNotEmpty) _regionTapController.add(id);
        case 'onRegionCardAction':
          final args = call.arguments as Map;
          final id = args['id'] as String?;
          final action = args['action'] as String?;
          if (id != null && id.isNotEmpty && action != null) {
            _regionCardActionController.add((id, action));
          }
      }
    });
  }

  // ── Region eyes (Grammarly mode) ──

  /// Full screen size in points: {'w', 'h'} (for frame→screen bbox scaling).
  Future<Map<String, double>?> getScreenSize() async {
    try {
      final result = await _channel.invokeMethod('getScreenSize');
      if (result is Map) {
        return {
          'w': (result['w'] as num).toDouble(),
          'h': (result['h'] as num).toDouble(),
        };
      }
    } catch (e) {
      _log('getScreenSize failed: $e');
    }
    return null;
  }

  /// All displays with their global Cocoa frames + id (multi-display). Each:
  /// {id, x, y, w, h}. Used to size/place a region's eye on the display it was
  /// detected on.
  Future<List<Map<String, double>>?> getScreens() async {
    try {
      final result = await _channel.invokeMethod('getScreens');
      if (result is List) {
        return result.map<Map<String, double>>((s) {
          final m = s as Map;
          return {
            'id': (m['id'] as num).toDouble(),
            'x': (m['x'] as num).toDouble(),
            'y': (m['y'] as num).toDouble(),
            'w': (m['w'] as num).toDouble(),
            'h': (m['h'] as num).toDouble(),
          };
        }).toList();
      }
    } catch (e) {
      _log('getScreens failed: $e');
    }
    return null;
  }

  /// Reconcile the native region-eye panel set against [eyes].
  /// Each entry: {'id': String, 'x': double, 'y': double, 'state': String}
  /// with x/y in top-left-origin screen points. Panels for ids absent from
  /// the list are closed; existing ones are repositioned/restyled.
  /// Screenshot-style drag-select. On release the user picks Chat or Term from
  /// a toolbar under the box. Returns the numeric rect ({x,y,w,h,screenW,
  /// screenH}, top-left-origin) plus a `mode` of 'chat' | 'term', or null if
  /// the user cancelled (Esc / ✕). `mode` is the only non-numeric entry.
  Future<Map<String, Object>?> selectRegion() async {
    try {
      final raw = await _channel.invokeMethod('selectRegion');
      if (raw is! Map) return null;
      final out = <String, Object>{};
      raw.forEach((k, v) {
        final key = k.toString();
        out[key] = v is num ? v.toDouble() : v.toString();
      });
      return out;
    } catch (e) {
      _log('selectRegion failed: $e');
      return null;
    }
  }

  Future<void> showRegionEyes(List<Map<String, dynamic>> eyes) async {
    try {
      await _channel.invokeMethod('showRegionEyes', {'eyes': eyes});
    } catch (e) {
      _log('showRegionEyes failed: $e');
    }
  }

  /// Toggle the native suggestion card next to the eye [id], shown at the ROI:
  /// the issue + tip and a Chat / Term choice. Button taps come back over
  /// [regionCardActionStream].
  Future<void> toggleRegionPreview(String id, String issue, String tip,
      {bool hasTerminal = true}) async {
    try {
      await _channel.invokeMethod('toggleRegionPreview',
          {'id': id, 'issue': issue, 'tip': tip, 'hasTerminal': hasTerminal});
    } catch (e) {
      _log('toggleRegionPreview failed: $e');
    }
  }

  Future<void> hideRegionPreview() async {
    try {
      await _channel.invokeMethod('hideRegionPreview');
    } catch (e) {
      _log('hideRegionPreview failed: $e');
    }
  }

  /// Seed copied for a region's ROI card → green check + auto-dismiss.
  Future<void> confirmRegionCopy(String id) async {
    try {
      await _channel.invokeMethod('confirmRegionCopy', {'id': id});
    } catch (e) {
      _log('confirmRegionCopy failed: $e');
    }
  }

  /// Update one eye's badge state: 'idle' | 'working' | 'ready' | 'failed'.
  Future<void> updateRegionEye(String id, String state) async {
    try {
      await _channel.invokeMethod('updateRegionEye', {'id': id, 'state': state});
    } catch (e) {
      _log('updateRegionEye failed: $e');
    }
  }

  /// Close all region eye panels.
  Future<void> clearRegionEyes() async {
    try {
      await _channel.invokeMethod('clearRegionEyes');
    } catch (e) {
      _log('clearRegionEyes failed: $e');
    }
  }

  void _log(String msg) {
    // ignore: avoid_print
    print('[WindowService] $msg');
  }
}
