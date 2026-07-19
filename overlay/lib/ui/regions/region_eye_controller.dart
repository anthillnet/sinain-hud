import 'dart:async';
import 'dart:ui';
import '../../core/models/region_highlight.dart';
import '../../core/models/thread_status.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';
import '../../core/services/window_service.dart';

/// Shift [pos] down in eye-sized steps until it no longer overlaps any of
/// the already-[placed] eyes, wrapping to the top edge at the bottom of the
/// screen. Bounded — gives up (accepts overlap) on a saturated screen.
/// Pure function so the collision behavior is unit-testable.
Offset resolveEyeCollision(Offset pos, Iterable<Offset> placed, double screenH,
    {double eyeSize = 48}) {
  final gap = eyeSize + 8;
  bool collides(Offset p) => placed.any(
      (o) => (o.dx - p.dx).abs() < eyeSize && (o.dy - p.dy).abs() < eyeSize);
  var candidate = pos;
  for (var attempts = 0; collides(candidate) && attempts < 40; attempts++) {
    var next = candidate.translate(0, gap);
    if (next.dy > screenH - eyeSize - 8) {
      next = Offset(candidate.dx, 8.0); // wrap to the top edge
    }
    candidate = next;
  }
  return candidate;
}

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
  /// [teleport] is false for a single tap (toggle the lightweight preview) and
  /// true for a double tap (move the HUD/chat to the region).
  final void Function(RegionHighlight region, Offset pos, bool teleport)
      onRegionTap;

  /// "Term" chosen on the native ROI card — open the region as a terminal
  /// thread (vs onRegionTap which opens a chat thread).
  final void Function(RegionHighlight region, Offset pos) onRegionTerminal;

  /// "Copy" chosen on the native ROI card — copy this region's composed seed
  /// to the clipboard (for agents we don't integrate with).
  final void Function(RegionHighlight region) onRegionCopy;

  // Eye size follows the HUD font-size setting (default 12 → 24pt eyes,
  // matching the original fixed size); color follows the accent setting.
  double get _eyeSize => settingsService.settings.fontSize * 2;

  StreamSubscription<List<RegionHighlight>>? _regionSub;
  StreamSubscription<String>? _tapSub;
  StreamSubscription<(String, String)>? _cardActionSub;
  StreamSubscription<ThreadStatusUpdate>? _taskSub;
  VoidCallback? _settingsListener;

  final Map<String, RegionHighlight> _regions = {};
  final Map<String, Offset> _eyePositions = {};
  // 'idle' | 'working' | 'ready' | 'failed' — survives region set refreshes
  final Map<String, String> _eyeStates = {};
  // Island route-card catches use the card as their only surface. Keep their
  // core region alive for routing, but never reconcile a native eye/panel for
  // them. Other manual catches still follow the legacy eye flow.
  final Set<String> _excludedRegionIds = {};
  // Single/double-tap discrimination on the native eye-tap stream.
  String? _pendingTapId;
  Timer? _pendingTapTimer;

  RegionEyeController({
    required this.windowService,
    required this.ws,
    required this.settingsService,
    required this.onRegionTap,
    required this.onRegionTerminal,
    required this.onRegionCopy,
  });

  bool get _enabled => settingsService.settings.autoDetectIssues;

  bool _lastEnabled = false;
  int _lastAccent = 0;
  double _lastFontSize = 0;
  bool _wasConnected = false;
  VoidCallback? _wsListener;

  void start() {
    _regionSub = ws.regionStream.listen(_onRegions);
    _tapSub = windowService.regionTapStream.listen(_onTap);
    _cardActionSub = windowService.regionCardActionStream.listen(_onCardAction);
    _taskSub = ws.spawnTaskStream.listen(_onSpawnTask);
    _lastEnabled = _enabled;
    _settingsListener = () {
      // Re-render eyes when their appearance settings change.
      final accent = settingsService.settings.accentColor;
      final size = settingsService.settings.fontSize;
      if (accent != _lastAccent || size != _lastFontSize) {
        _lastAccent = accent;
        _lastFontSize = size;
        if (_enabled && ws.regions.isNotEmpty) _onRegions(ws.regions);
      }
      if (_enabled == _lastEnabled) return;
      _lastEnabled = _enabled;
      // The overlay toggle is the source of truth — push to core so the
      // analyzer only spends prompt tokens on regions when enabled.
      _pushEnableState();
      if (!_enabled) {
        // Remove detected eyes but retain user-created manual catches.
        _onRegions(ws.regions);
      } else if (ws.regions.isNotEmpty) {
        _onRegions(ws.regions);
      }
    };
    settingsService.addListener(_settingsListener!);
    // Sync the toggle to core on every (re)connect — core may have restarted
    // with the boot default (AUTO_DETECT_ISSUES, off).
    _wsListener = () {
      if (ws.connected && !_wasConnected) _pushEnableState();
      _wasConnected = ws.connected;
    };
    ws.addListener(_wsListener!);
    if (ws.connected) {
      _wasConnected = true;
      _pushEnableState();
    }
    // Late join: core replays the current region set on connect, but if it
    // arrived before this controller started, render what's already cached.
    if (ws.regions.isNotEmpty) _onRegions(ws.regions);
  }

  void _pushEnableState() {
    ws.sendCommand('set_auto_detect', {'enabled': _enabled});
  }

  void dispose() {
    _regionSub?.cancel();
    _tapSub?.cancel();
    _cardActionSub?.cancel();
    _pendingTapTimer?.cancel();
    _taskSub?.cancel();
    if (_settingsListener != null) {
      settingsService.removeListener(_settingsListener!);
    }
    if (_wsListener != null) {
      ws.removeListener(_wsListener!);
    }
    windowService.clearRegionEyes();
  }

  Future<void> _onRegions(List<RegionHighlight> regions) async {
    // Manual catches are user-requested, not auto-detection. They must remain
    // visible even when the ambient auto-detect preference is disabled.
    final eligibleRegions = _enabled
        ? regions
        : regions.where((r) => r.id.startsWith('r-man-')).toList();
    final visibleRegions = eligibleRegions
        .where((r) => !_excludedRegionIds.contains(r.id))
        .toList();

    _excludedRegionIds
        .removeWhere((id) => !regions.any((region) => region.id == id));

    _regions
      ..clear()
      ..addEntries(visibleRegions.map((r) => MapEntry(r.id, r)));
    // Drop badge state for regions that disappeared
    _eyeStates.removeWhere((id, _) => !_regions.containsKey(id));
    _eyePositions.clear();

    // Multi-display: size + place each eye against the display it was detected
    // on (region.display). Positions are top-left WITHIN that display; native
    // applies the per-display offset + flip. Falls back to the primary screen.
    final screens = await windowService.getScreens();
    Map<String, double> primaryScreen() {
      if (screens != null && screens.isNotEmpty) {
        return screens.firstWhere((s) => s['x'] == 0 && s['y'] == 0,
            orElse: () => screens.first);
      }
      return {'id': 0.0, 'w': 1440.0, 'h': 900.0};
    }

    Map<String, double> screenFor(int display) {
      if (screens != null && display != 0) {
        for (final s in screens) {
          if (s['id'] == display.toDouble()) return s;
        }
      }
      return primaryScreen();
    }

    var cornerSlot = 0;
    final eyes = <Map<String, dynamic>>[];
    for (final r in visibleRegions) {
      final scr = screenFor(r.display);
      final screenW = scr['w']!;
      final screenH = scr['h']!;
      Offset pos;
      if (r.bbox != null &&
          r.frameSize != null &&
          r.frameSize![0] > 0 &&
          r.frameSize![1] > 0) {
        final sx = screenW / r.frameSize![0];
        final sy = screenH / r.frameSize![1];
        // Eye at the bbox's top-right corner, just outside the content
        pos = Offset(
          (r.bbox![0] + r.bbox![2]) * sx - _eyeSize / 2,
          r.bbox![1] * sy - _eyeSize / 4,
        );
      } else {
        // No anchor — stack below the top-right corner
        pos =
            Offset(screenW - _eyeSize - 16, 72.0 + cornerSlot * (_eyeSize + 8));
        cornerSlot++;
      }
      pos = Offset(
        pos.dx.clamp(8.0, screenW - _eyeSize - 8),
        pos.dy.clamp(8.0, screenH - _eyeSize - 8),
      );
      // De-overlap: regions anchored to the same sense event share a bbox —
      // shift colliding eyes downward so each stays visible and tappable.
      pos = resolveEyeCollision(pos, _eyePositions.values, screenH);
      _eyePositions[r.id] = pos;
      eyes.add({
        'id': r.id,
        'x': pos.dx,
        'y': pos.dy,
        'display': r.display,
        // A live spawn state (working/failed) wins; otherwise a pending
        // (restored) or provisional (SLM placeholder, awaiting the main lane's
        // quality label) region renders dimmed until confirmed/upgraded.
        'state': _eyeStates[r.id] ??
            ((r.pending || r.provisional) ? 'pending' : 'idle'),
        'size': _eyeSize,
        'accent': settingsService.settings.accentColor,
      });
    }
    await windowService.showRegionEyes(eyes);
  }

  /// Remove and continue suppressing the native eye for an island route-card
  /// catch. Reconciliation is immediate so this also closes an eye that won a
  /// listener race and was briefly created from the region broadcast.
  Future<void> excludeRegion(String id) async {
    _excludedRegionIds.add(id);
    await windowService.hideRegionPreview();
    await _onRegions(ws.regions);
  }

  /// Ensure a newly caught manual ROI is reconciled, then open its native
  /// suggestion card. This is explicit because auto-detection may be off.
  Future<void> showRegionCard(String id) async {
    await _onRegions(ws.regions);
    final region = _regions[id];
    if (region == null) return;
    await windowService.toggleRegionPreview(
      region.id,
      region.issue,
      region.tip,
    );
  }

  void _onTap(String id) {
    final region = _regions[id];
    final pos = _eyePositions[id];
    if (region == null || pos == null) return;

    // Single vs double tap: a second tap on the same eye within the window is a
    // double → teleport the HUD to it; a lone tap → toggle its preview.
    if (_pendingTapId == id && _pendingTapTimer?.isActive == true) {
      _pendingTapTimer?.cancel();
      _pendingTapId = null;
      windowService.hideRegionPreview(); // clear preview, then teleport
      onRegionTap(region, pos, true); // double → teleport
      return;
    }
    _pendingTapTimer?.cancel();
    _pendingTapId = id;
    _pendingTapTimer = Timer(const Duration(milliseconds: 280), () {
      _pendingTapId = null;
      // single → toggle the native suggestion card AT the ROI (issue + tip +
      // Chat/Term choice). No HUD needed until the user picks an action.
      windowService.toggleRegionPreview(region.id, region.issue, region.tip);
    });
  }

  /// A Chat/Term button on the native ROI card was tapped — open the matching
  /// thread for the region. The native card has already dismissed itself.
  void _onCardAction((String, String) ev) {
    final region = _regions[ev.$1];
    final pos = _eyePositions[ev.$1];
    if (region == null || pos == null) return;
    if (ev.$2 == 'copy') {
      onRegionCopy(region);
    } else if (ev.$2 == 'term') {
      onRegionTerminal(region, pos);
    } else {
      run(region); // start the agent (desktop lane → core launches the app)
      // A desktop chat (Claude Desktop / ChatGPT) opens the external app, so
      // don't also open the in-HUD chat surface for it.
      if (!ws.escalationDesktop) {
        onRegionTap(region, pos, true); // open the chat thread at the ROI
      }
    }
  }

  /// Start the region's agent thread — called from the region action
  /// banner's explicit Run button. Core routes it to the currently selected
  /// escalation agent under a stable per-ROI session, so follow-ups continue
  /// the same conversation.
  void run(RegionHighlight region) {
    final state = _eyeStates[region.id] ?? 'idle';
    if (state == 'working') return; // already running
    markWorking(region.id);
    // Text is the user-visible feed echo; core assembles the real first
    // message from the tracked region (issue + tip + source OCR + digest).
    ws.sendSpawnCommand('[👁 ${region.action ?? "help"}] ${region.issue}',
        regionId: region.id);
  }

  /// Flip a region's eye badge to working — used for thread follow-ups sent
  /// from the chat input (the shell sends the message itself).
  void markWorking(String regionId) {
    _eyeStates[regionId] = 'working';
    windowService.updateRegionEye(regionId, 'working');
  }

  void _onSpawnTask(ThreadStatusUpdate task) {
    final id = task.regionId;
    if (id == null || !_regions.containsKey(id)) return;
    final state = switch (task.status) {
      ThreadStatus.completed => 'ready',
      ThreadStatus.failed || ThreadStatus.timeout => 'failed',
      _ => 'working',
    };
    if (_eyeStates[id] == state) return;
    _eyeStates[id] = state;
    windowService.updateRegionEye(id, state);
  }
}
