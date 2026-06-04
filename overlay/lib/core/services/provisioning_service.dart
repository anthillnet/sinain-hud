import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// One provisioning component's live status (Python, whisper model, Ollama).
class ProvisioningItem {
  ProvisioningItem(this.name, this.state, this.pct, this.label);

  final String name; // file stem: python | whisper | ollama
  final String state; // active | done | error
  final int? pct; // 0..100 or null (indeterminate)
  final String label;

  bool get active => state == 'active';
  bool get error => state == 'error';
}

/// SEED-001 — surfaces local-mode setup progress to the overlay.
///
/// The provisioning scripts (provision-python/whisper/ollama.sh) write
/// `~/.sinain/provisioning/<name>.status` as `state|pct|label`. This service
/// polls that directory directly — independent of sinain-core, so progress is
/// visible even while the backend is still downloading/starting. No-op when the
/// directory never appears (dev / nothing to provision).
class ProvisioningService extends ChangeNotifier {
  ProvisioningService() {
    _timer = Timer.periodic(const Duration(milliseconds: 900), (_) => _poll());
    _poll();
  }

  Timer? _timer;
  List<ProvisioningItem> _items = [];
  DateTime? _lastActive;

  List<ProvisioningItem> get items => _items;

  /// Show the banner while anything is actively provisioning, and linger a few
  /// seconds after the last item finishes so the user sees the ✓ / error.
  bool get visible {
    if (_items.any((i) => i.active)) return true;
    if (_items.isEmpty) return false;
    if (_lastActive == null) return false;
    return DateTime.now().difference(_lastActive!) < const Duration(seconds: 4);
  }

  String get _dir {
    final home = Platform.environment['HOME'] ?? '';
    return '$home/.sinain/provisioning';
  }

  void _poll() {
    final dir = Directory(_dir);
    if (!dir.existsSync()) {
      if (_items.isNotEmpty) {
        _items = [];
        notifyListeners();
      }
      return;
    }
    final next = <ProvisioningItem>[];
    for (final f in dir.listSync()) {
      if (f is! File || !f.path.endsWith('.status')) continue;
      try {
        final name = f.uri.pathSegments.last.replaceAll('.status', '');
        final parts = f.readAsStringSync().trim().split('|');
        final state = parts.isNotEmpty ? parts[0] : '';
        final pct = parts.length > 1 && parts[1].isNotEmpty
            ? int.tryParse(parts[1])
            : null;
        final label = parts.length > 2 ? parts[2] : name;
        next.add(ProvisioningItem(name, state, pct, label));
      } catch (_) {
        /* mid-write; skip this tick */
      }
    }
    next.sort((a, b) => a.name.compareTo(b.name));
    if (next.any((i) => i.active)) _lastActive = DateTime.now();

    if (_changed(next)) {
      _items = next;
      notifyListeners();
    }
  }

  bool _changed(List<ProvisioningItem> next) {
    if (next.length != _items.length) return true;
    for (var i = 0; i < next.length; i++) {
      final a = next[i], b = _items[i];
      if (a.name != b.name || a.state != b.state || a.pct != b.pct || a.label != b.label) {
        return true;
      }
    }
    return false;
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
