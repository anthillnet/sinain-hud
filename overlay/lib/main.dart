import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'core/constants.dart';
import 'core/services/onboarding_service.dart';
import 'core/models/hud_settings.dart';
import 'core/services/settings_service.dart';
import 'core/services/first_run_service.dart';
import 'core/services/provisioning_service.dart';
import 'core/services/websocket_service.dart';
import 'core/services/update_check_service.dart';
import 'core/services/window_service.dart';
import 'ui/first_run/first_run_wizard.dart';
import 'ui/first_run/provisioning_banner.dart';
import 'ui/overlay_shell.dart';

/// Global key for OverlayShell so hotkey handler can trigger state changes.
final overlayShellKey = GlobalKey<OverlayShellState>();

void main() async {
  // Catch Flutter rendering errors
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    debugPrint('[overlay] ⚠ FlutterError: ${details.exceptionAsString()}');
    if (details.stack != null) {
      debugPrint(
          '[overlay] ${details.stack.toString().split('\n').take(5).join('\n')}');
    }
  };

  runZonedGuarded(() async {
    WidgetsFlutterBinding.ensureInitialized();
    await _startApp();
  }, (error, stack) {
    debugPrint('[overlay] ⚠ Unhandled error: $error');
    debugPrint('[overlay] ${stack.toString().split('\n').take(5).join('\n')}');
  });
}

Future<void> _startApp() async {
  // Initialize services
  final windowService = WindowService();
  final settingsService = SettingsService();
  await settingsService.init();

  debugPrint(
      '[overlay] settings loaded: state=${settingsService.settings.overlayState.name} '
      'fontSize=${settingsService.settings.fontSize} '
      'accentColor=0x${settingsService.settings.accentColor.toRadixString(16)}');

  final onboardingService = OnboardingService();
  await onboardingService.init();

  // First-run wizard gate (packaged DMG only — no-op under `flutter run`).
  final firstRunService = FirstRunService();
  await firstRunService.init();

  // Local-mode setup progress (polls ~/.sinain/provisioning/*.status).
  final provisioningService = ProvisioningService();

  final wsService = WebSocketService(url: settingsService.settings.wsUrl);

  // In-app update check (DMG installs only — no-op elsewhere). DMG installs
  // have no auto-update; this surfaces "update available" in display settings.
  final updateCheckService = UpdateCheckService()..start();

  // Configure native window
  await windowService.setTransparent();
  await windowService.setPrivacyMode(true);
  await windowService.setAlwaysOnTop(true);

  // During first-run setup, resize window for the wizard panel.
  if (firstRunService.needsSetup) {
    await windowService.setWindowFrame(100, 200, 340, 420);
  }

  // Resize for the setup-progress banner while provisioning runs; restore the
  // normal HUD size when it finishes.
  void syncProvisioningWindow() {
    if (provisioningService.visible) {
      windowService.setWindowFrame(100, 200, 360, 230);
    } else if (!firstRunService.needsSetup) {
      final s = settingsService.settings;
      final w = s.overlayState == HudState.chat
          ? s.chatWidth
          : s.overlayState == HudState.controls
              ? 360.0
              : 48.0;
      final h = s.overlayState == HudState.chat ? s.chatHeight : 48.0;
      final x = s.eyeX >= 0 ? s.eyeX : 100.0;
      final y = s.eyeY >= 0 ? s.eyeY : 200.0;
      windowService.setWindowFrame(x, y, w, h);
      if (s.overlayState == HudState.chat) windowService.makeKeyWindow();
    }
  }

  if (provisioningService.visible) {
    await windowService.setWindowFrame(100, 200, 360, 230);
  }
  provisioningService.addListener(syncProvisioningWindow);

  // Restore persisted position (if saved)
  if (settingsService.settings.eyeX >= 0) {
    final s = settingsService.settings;
    // Size depends on saved state
    final w = s.overlayState == HudState.chat
        ? s.chatWidth
        : s.overlayState == HudState.controls
            ? 360.0
            : 48.0;
    final h = s.overlayState == HudState.chat ? s.chatHeight : 48.0;
    await windowService.setWindowFrame(s.eyeX, s.eyeY, w, h);
  }

  // Default state is chat — make key window so text input works immediately
  if (settingsService.settings.overlayState == HudState.chat) {
    await windowService.makeKeyWindow();
  }

  // Listen for hotkey events from native side
  const hotkeyChannel = MethodChannel('sinain_hud/hotkeys');
  hotkeyChannel.setMethodCallHandler((call) async {
    switch (call.method) {
      // Navigation
      case 'onToggleVisibility':
        overlayShellKey.currentState?.toggleVisibility(call.arguments as bool);
      case 'onCycleState':
        overlayShellKey.currentState?.cycleState();
      case 'onQuit':
        wsService.disconnect();
      case 'onToggleChat':
        overlayShellKey.currentState?.toggleChat();
      case 'onCycleTab':
        settingsService.cycleTab();
      case 'onResetPosition':
        overlayShellKey.currentState?.resetPosition();
      case 'onFocusInput':
        overlayShellKey.currentState?.focusInput();

      // Capture toggles
      case 'onToggleAudio':
        wsService.sendCommand('toggle_audio');
      case 'onToggleScreen':
        wsService.sendCommand('toggle_screen');
      case 'onTogglePrivacy':
        settingsService.setPrivacyModeTransient(call.arguments as bool);

      // Feed display
      case 'onToggleAudioFeed':
        wsService.toggleAudioFeed();
      case 'onToggleScreenFeed':
        wsService.toggleScreenFeed();
      case 'onScrollFeed':
        wsService.scrollFeed(call.arguments as String);
      case 'onCopyMessage':
        wsService.requestCopy(settingsService.settings.activeTab.name);
    }
  });

  // Connect WebSocket
  wsService.connect();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: onboardingService),
        ChangeNotifierProvider.value(value: firstRunService),
        ChangeNotifierProvider.value(value: provisioningService),
        ChangeNotifierProvider.value(value: settingsService),
        ChangeNotifierProvider.value(value: wsService),
        ChangeNotifierProvider.value(value: updateCheckService),
        Provider.value(value: windowService),
      ],
      child: const SinainHudApp(),
    ),
  );
}

class SinainHudApp extends StatelessWidget {
  const SinainHudApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SinainHUD',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.transparent,
        canvasColor: Colors.transparent,
        fontFamily: HudConstants.monoFont,
        fontFamilyFallback: HudConstants.monoFontFallbacks,
        textTheme: const TextTheme(
          bodyMedium: TextStyle(
            fontFamily: HudConstants.monoFont,
            fontFamilyFallback: HudConstants.monoFontFallbacks,
            fontSize: 12,
            color: Colors.white,
          ),
        ),
      ),
      home: Scaffold(
        backgroundColor: Colors.transparent,
        body: Consumer2<FirstRunService, ProvisioningService>(
          builder: (context, firstRun, provisioning, _) {
            if (firstRun.needsSetup) {
              return Center(
                child: FirstRunWizard(
                  service: firstRun,
                  onComplete: () {
                    // Shrink the window back to the default eye/chat size; the
                    // needsSetup flip rebuilds this Consumer into OverlayShell.
                    Provider.of<WindowService>(context, listen: false)
                        .setWindowFrame(100, 200, 320, 380);
                  },
                ),
              );
            }
            if (provisioning.visible) {
              return Center(
                child: ProvisioningBanner(
                  service: provisioning,
                  onDrag: (d) =>
                      Provider.of<WindowService>(context, listen: false)
                          .moveWindowBy(d.delta.dx, -d.delta.dy),
                ),
              );
            }
            return OverlayShell(key: overlayShellKey);
          },
        ),
      ),
    );
  }
}
