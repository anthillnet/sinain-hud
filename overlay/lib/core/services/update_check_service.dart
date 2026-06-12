import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';

/// In-app update check for DMG installs.
///
/// The DMG build bakes its release version into
/// `Sinain.app/Contents/Resources/DMG_VERSION` (see tools/dmg/
/// stage-backend.sh). On startup (and daily) this compares it against the
/// newest `macos-v*` GitHub release and exposes [availableVersion] when the
/// install is outdated — DMG installs have no auto-update, so without this
/// users on old builds never find out.
///
/// No-op for non-DMG runs (flutter run, npx prebuilt) — they have no
/// DMG_VERSION file.
class UpdateCheckService extends ChangeNotifier {
  static const _releasesApi =
      'https://api.github.com/repos/anthillnet/sinain-hud/releases?per_page=20';
  static const downloadUrl = 'https://sinain.com';
  static const _recheckEvery = Duration(hours: 24);

  String? installedVersion;

  /// Newer DMG version available for download (null = up to date / unknown).
  String? availableVersion;

  Timer? _timer;

  /// Start the periodic check. Safe to call once at app init.
  void start() {
    _check();
    _timer = Timer.periodic(_recheckEvery, (_) => _check());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _check() async {
    try {
      installedVersion ??= _readInstalledVersion();
      if (installedVersion == null) return; // not a DMG install
      if (_networkOptedOut()) return; // paranoid / full-local: no beacons

      final latest = await _fetchLatestDmgVersion();
      if (latest == null) return;

      final newer = _isNewer(latest, installedVersion!);
      final next = newer ? latest : null;
      if (next != availableVersion) {
        availableVersion = next;
        notifyListeners();
      }
    } catch (e) {
      if (kDebugMode) print('[UpdateCheck] failed: $e');
    }
  }

  /// Honor the privacy promise: in paranoid mode or full-local mode the user
  /// chose "nothing leaves my machine" — that includes update-check requests
  /// to the GitHub API. Reads the same ~/.sinain/.env the backend uses.
  bool _networkOptedOut() {
    try {
      final home = Platform.environment['HOME'] ?? '';
      if (home.isEmpty) return false;
      final env = File('$home/.sinain/.env');
      if (!env.existsSync()) return false;
      for (final line in env.readAsLinesSync()) {
        final l = line.trim();
        if (l.startsWith('PRIVACY_MODE=') && l.endsWith('paranoid')) {
          return true;
        }
        if (l.startsWith('SINAIN_LOCAL_MODE=') && l.endsWith('true')) {
          return true;
        }
      }
    } catch (_) {/* unreadable env — default to checking */}
    return false;
  }

  String? _readInstalledVersion() {
    if (!Platform.isMacOS) return null;
    // Contents/MacOS/<exe> → Contents/Resources/DMG_VERSION
    final macosDir = File(Platform.resolvedExecutable).parent;
    final f = File('${macosDir.parent.path}/Resources/DMG_VERSION');
    if (!f.existsSync()) return null;
    final v = f.readAsStringSync().trim();
    return v.isEmpty ? null : v;
  }

  Future<String?> _fetchLatestDmgVersion() async {
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse(_releasesApi));
      req.headers.set(HttpHeaders.userAgentHeader, 'sinain-hud-update-check');
      req.headers.set(HttpHeaders.acceptHeader, 'application/vnd.github+json');
      final res = await req.close().timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return null;
      final body = await res.transform(utf8.decoder).join();
      final releases = jsonDecode(body) as List<dynamic>;
      for (final r in releases) {
        final tag = (r as Map<String, dynamic>)['tag_name'] as String? ?? '';
        if (tag.startsWith('macos-v')) return tag.substring('macos-v'.length);
      }
      return null;
    } finally {
      client.close();
    }
  }

  /// Numeric dotted-version compare: true when [a] > [b].
  static bool _isNewer(String a, String b) {
    List<int> parts(String v) => v
        .split(RegExp(r'[.+-]'))
        .map((p) => int.tryParse(p) ?? 0)
        .toList();
    final pa = parts(a), pb = parts(b);
    final n = pa.length > pb.length ? pa.length : pb.length;
    for (var i = 0; i < n; i++) {
      final x = i < pa.length ? pa[i] : 0;
      final y = i < pb.length ? pb[i] : 0;
      if (x != y) return x > y;
    }
    return false;
  }
}
