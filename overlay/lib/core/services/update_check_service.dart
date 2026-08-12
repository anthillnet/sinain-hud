import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

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
  /// Settings hook: when it returns false, periodic checks (and background
  /// downloads) stop — the explicit opt-out. Manual checkNow() still works.
  bool Function() autoCheckEnabled = () => true;

  static const _releasesApi =
      'https://api.github.com/repos/anthillnet/sinain-hud/releases?per_page=20';
  static const downloadUrl = 'https://sinain.com';
  static const _recheckEvery = Duration(hours: 24);

  String? installedVersion;

  /// Newer DMG version available for download (null = up to date / unknown).
  String? availableVersion;

  /// Wall-clock of the last completed check against the releases API — lets
  /// the settings row distinguish "up to date" from "never managed to check".
  DateTime? lastChecked;

  /// True while a manual checkNow() is in flight (drives the settings row).
  bool checkingNow = false;

  String? _bundleVersionCache;

  /// Version to show in settings at all times: the DMG release version for
  /// packaged installs (the number update checks compare), else the app
  /// bundle's short version (dev / npx-prebuilt runs).
  String? get displayVersion {
    installedVersion ??= _readInstalledVersion();
    return installedVersion ?? (_bundleVersionCache ??= _readBundleVersion());
  }

  /// Update fully downloaded and waiting for a restart to apply. The swap is
  /// quit-then-replace, so the background flow stops here — the app never
  /// yanks itself out from under the user.
  String? stagedVersion;
  String? _stagedDmgPath;

  Timer? _timer;

  // ── One-click install state ──
  /// 'downloading' | 'installing' while an update is being applied; null idle.
  String? installStage;

  /// Download progress 0..1 (−1 when the server didn't send a content length).
  double installProgress = 0;

  /// Last install failure (we fall back to opening the download page).
  String? installError;

  bool get installing => installStage != null;

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

  Future<void> _check({bool manual = false}) async {
    try {
      installedVersion ??= _readInstalledVersion();
      if (installedVersion == null) return; // not a DMG install
      if (_networkOptedOut()) return; // paranoid / full-local: no beacons
      if (!manual && !autoCheckEnabled()) return; // user opted out

      final latest = await _fetchLatestDmgVersion();
      if (latest == null) return;
      lastChecked = DateTime.now();

      final newer = _isNewer(latest, installedVersion!);
      final next = newer ? latest : null;
      if (next != availableVersion) {
        availableVersion = next;
        notifyListeners();
      }

      // Background self-update: stage the DMG now, apply on restart. Manual
      // checks stage too — the user explicitly asked.
      if (next != null &&
          stagedVersion != next &&
          !installing &&
          (manual || autoCheckEnabled())) {
        await _downloadDmg(next, background: true);
      }
    } catch (e) {
      if (kDebugMode) print('[UpdateCheck] failed: $e');
    }
  }

  /// Settings-row "check now" — works even when auto-check is off.
  Future<void> checkNow() async {
    checkingNow = true;
    notifyListeners();
    try {
      await _check(manual: true);
    } finally {
      checkingNow = false;
      notifyListeners();
    }
  }

  /// Restart into a staged update (no-op when nothing is staged).
  Future<void> restartToApply() async {
    final dmg = _stagedDmgPath;
    if (dmg == null || installing) return;
    installStage = 'installing';
    notifyListeners();
    try {
      const channel = MethodChannel('sinain_hud/backend');
      final ok = await channel
          .invokeMethod<bool>('installUpdate', {'dmgPath': dmg});
      if (ok != true) throw const FormatException('native install declined');
      // App is about to terminate and relaunch as the new version.
    } catch (e) {
      installError = '$e';
      installStage = null;
      stagedVersion = null;
      _stagedDmgPath = null;
      notifyListeners();
      await launchDownloadPage();
    }
  }

  /// Download the DMG to a temp file. In background mode it only stages
  /// (restart applies it); otherwise the caller continues into the install.
  Future<File?> _downloadDmg(String version, {required bool background}) async {
    // Fetch through sinain.com/download (302 → GitHub) rather than GitHub
    // directly, so updater traffic lands in the download-stats funnel
    // (tools/download-redirect) instead of silently inflating GitHub's
    // asset counter. ?tag pins the exact release this check validated; the
    // versioned user-agent lets the worker classify updater vs human.
    final url = 'https://sinain.com/download?tag=macos-v$version';
    final client = HttpClient();
    File? dmg;
    try {
      final dir = Directory.systemTemp.createTempSync('sinain-update');
      dmg = File('${dir.path}/Sinain.dmg');
      final req = await client.getUrl(Uri.parse(url));
      req.headers.set(HttpHeaders.userAgentHeader,
          'sinain-hud-updater/${installedVersion ?? 'unknown'}');
      final res = await req.close().timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw HttpException('HTTP ${res.statusCode}');
      final total = res.contentLength; // −1 if unknown
      var received = 0;
      final sink = dmg.openWrite();
      await for (final chunk in res) {
        sink.add(chunk);
        received += chunk.length;
        if (!background) {
          installProgress = total > 0 ? received / total : -1;
          notifyListeners();
        }
      }
      await sink.close();
      if (background) {
        stagedVersion = version;
        _stagedDmgPath = dmg.path;
        notifyListeners();
      }
      return dmg;
    } catch (e) {
      try {
        dmg?.parent.deleteSync(recursive: true);
      } catch (_) {/* best effort */}
      if (kDebugMode) print('[UpdateCheck] download failed: $e');
      return null;
    } finally {
      client.close();
    }
  }

  /// Manual "Download & install": uses the staged DMG when the background
  /// flow already fetched it, else downloads with visible progress — then
  /// hands the file to the native side (quit → swap bundle → relaunch). On
  /// any failure it falls back to opening the download page.
  Future<void> downloadAndInstall() async {
    final version = availableVersion;
    if (installing || version == null) return;

    if (_stagedDmgPath != null) return restartToApply();

    installStage = 'downloading';
    installProgress = 0;
    installError = null;
    notifyListeners();

    final dmg = await _downloadDmg(version, background: false);
    if (dmg == null) {
      installError = 'download failed';
      installStage = null;
      installProgress = 0;
      notifyListeners();
      await launchDownloadPage();
      return;
    }
    _stagedDmgPath = dmg.path;
    stagedVersion = version;
    await restartToApply();
  }

  /// Open the public download page (manual-update fallback).
  Future<void> launchDownloadPage() async {
    try {
      await launchUrl(Uri.parse(downloadUrl),
          mode: LaunchMode.externalApplication);
    } catch (_) {/* best effort */}
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

  /// Overlay version from the app bundle's Info.plist — the settings-row
  /// fallback for runs without a DMG_VERSION (flutter run, npx prebuilt).
  String? _readBundleVersion() {
    if (!Platform.isMacOS) return null;
    try {
      final macosDir = File(Platform.resolvedExecutable).parent;
      final plist = File('${macosDir.parent.path}/Info.plist');
      if (!plist.existsSync()) return null;
      return RegExp(
              r'<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>')
          .firstMatch(plist.readAsStringSync())
          ?.group(1);
    } catch (_) {
      return null;
    }
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
