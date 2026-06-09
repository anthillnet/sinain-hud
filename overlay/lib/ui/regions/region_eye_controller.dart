import 'dart:async';
import 'dart:ui';
import '../../core/models/region_highlight.dart';
import '../../core/models/spawn_task.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';
import '../../core/services/window_service.dart';

/// Orchestrates Grammarly-mode region eyes (macOS).
///
/// Listens to region_highlight updates, positions native eye panels at the
/// scaled bbox locations, and maps spawn_task status events back onto eye
/// badges. The main HUD is the viewport: tapping an eye opens the chat near
/// the region with the issue + suggested approach ([onRegionTap]) — the user
/// launches the agent task explicitly from there via [spawn]. Eyes act as
/// tabs with status badges while tasks run in parallel.
class RegionEyeController {
  final WindowService windowService;
  final WebSocketService ws;
  final SettingsService settingsService;

  /// Tapped region + its eye position (top-left origin screen points).
  /// The shell opens the chat there and shows the region action banner.
  final void Function(RegionHighlight region, Offset pos) onRegionTap;

  static const double _eyeSize = 48;

  StreamSubscription<List<RegionHighlight>>? _regionSub;
  StreamSubscription<String>? _tapSub;
  StreamSubscription<SpawnTask>? _taskSub;
  VoidCallback? _settingsListener;

  final Map<String, RegionHighlight> _regions = {};
  final Map<String, Offset> _eyePositions = {};
  // 'idle' | 'working' | 'ready' | 'failed' — survives region set refreshes
  final Map<String, String> _eyeStates = {};
  DateTime _lastTap = DateTime.fromMillisecondsSinceEpoch(0);

  RegionEyeController({
    required this.windowService,
    required this.ws,
    required this.settingsService,
    required this.onRegionTap,
  });

  bool get _enabled => settingsService.settings.regionsEnabled;

  void start() {
    _regionSub = ws.regionStream.listen(_onRegions);
    _tapSub = windowService.regionTapStream.listen(_onTap);
    _taskSub = ws.spawnTaskStream.listen(_onSpawnTask);
    _settingsListener = () {
      if (!_enabled) {
        windowService.clearRegionEyes();
      } else if (ws.regions.isNotEmpty) {
        _onRegions(ws.regions);
      }
    };
    settingsService.addListener(_settingsListener!);
    // Late join: core replays the current region set on connect, but if it
    // arrived before this controller started, render what's already cached.
    if (ws.regions.isNotEmpty) _onRegions(ws.regions);
  }

  void dispose() {
    _regionSub?.cancel();
    _tapSub?.cancel();
    _taskSub?.cancel();
    if (_settingsListener != null) {
      settingsService.removeListener(_settingsListener!);
    }
    windowService.clearRegionEyes();
  }

  Future<void> _onRegions(List<RegionHighlight> regions) async {
    if (!_enabled) return;

    _regions
      ..clear()
      ..addEntries(regions.map((r) => MapEntry(r.id, r)));
    // Drop badge state for regions that disappeared
    _eyeStates.removeWhere((id, _) => !_regions.containsKey(id));
    _eyePositions.clear();

    final screen = await windowService.getScreenSize();
    final screenW = screen?['w'] ?? 1440;
    final screenH = screen?['h'] ?? 900;

    var cornerSlot = 0;
    final eyes = <Map<String, dynamic>>[];
    for (final r in regions) {
      Offset pos;
      if (r.bbox != null && r.frameSize != null &&
          r.frameSize![0] > 0 && r.frameSize![1] > 0) {
        final sx = screenW / r.frameSize![0];
        final sy = screenH / r.frameSize![1];
        // Eye at the bbox's top-right corner, just outside the content
        pos = Offset(
          (r.bbox![0] + r.bbox![2]) * sx - _eyeSize / 2,
          r.bbox![1] * sy - _eyeSize / 4,
        );
      } else {
        // No anchor — stack below the top-right corner
        pos = Offset(screenW - _eyeSize - 16, 72.0 + cornerSlot * (_eyeSize + 8));
        cornerSlot++;
      }
      pos = Offset(
        pos.dx.clamp(8.0, screenW - _eyeSize - 8),
        pos.dy.clamp(8.0, screenH - _eyeSize - 8),
      );
      _eyePositions[r.id] = pos;
      eyes.add({
        'id': r.id,
        'x': pos.dx,
        'y': pos.dy,
        'state': _eyeStates[r.id] ?? 'idle',
      });
    }
    await windowService.showRegionEyes(eyes);
  }

  void _onTap(String id) {
    final region = _regions[id];
    final pos = _eyePositions[id];
    if (region == null || pos == null) return;

    // Debounce double-taps
    final now = DateTime.now();
    if (now.difference(_lastTap).inMilliseconds < 500) return;
    _lastTap = now;

    // Never auto-spawn — surface the issue + suggested approach in the chat
    // and let the user launch the task explicitly (see spawn()).
    onRegionTap(region, pos);
  }

  /// Launch the agent task for a region — called from the region action
  /// banner's explicit Run button.
  void spawn(RegionHighlight region) {
    final state = _eyeStates[region.id] ?? 'idle';
    if (state == 'working') return; // already running
    _eyeStates[region.id] = 'working';
    windowService.updateRegionEye(region.id, 'working');
    // Text is the user-visible feed echo; core assembles the real task
    // from the tracked region (issue + tip + source OCR + digest).
    ws.sendSpawnCommand('[👁 ${region.action ?? "help"}] ${region.issue}',
        regionId: region.id);
  }

  void _onSpawnTask(SpawnTask task) {
    final id = task.regionId;
    if (id == null || !_regions.containsKey(id)) return;
    final state = switch (task.status) {
      SpawnTaskStatus.completed => 'ready',
      SpawnTaskStatus.failed || SpawnTaskStatus.timeout => 'failed',
      _ => 'working',
    };
    if (_eyeStates[id] == state) return;
    _eyeStates[id] = state;
    windowService.updateRegionEye(id, state);
  }
}
