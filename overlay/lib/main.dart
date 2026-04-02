import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'core/constants.dart';
import 'core/services/onboarding_service.dart';
import 'core/models/hud_settings.dart';
import 'core/services/settings_service.dart';
import 'core/services/websocket_service.dart';
import 'core/services/window_service.dart';
import 'ui/overlay_shell.dart';

/// Global key for OverlayShell so hotkey handler can trigger state changes.
final overlayShellKey = GlobalKey<OverlayShellState>();

void main() async {
  // Catch Flutter rendering errors
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    debugPrint('[overlay] ⚠ FlutterError: ${details.exceptionAsString()}');
    if (details.stack != null) {
      debugPrint('[overlay] ${details.stack.toString().split('\n').take(5).join('\n')}');
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

  debugPrint('[overlay] settings loaded: state=${settingsService.settings.overlayState.name} '
      'fontSize=${settingsService.settings.fontSize} '
      'accentColor=0x${settingsService.settings.accentColor.toRadixString(16)}');

  final onboardingService = OnboardingService();
  await onboardingService.init();

  final wsService = WebSocketService(url: settingsService.settings.wsUrl);

  // Configure native window
  await windowService.setTransparent();
  await windowService.setPrivacyMode(true);
  await windowService.setAlwaysOnTop(true);

  // During onboarding, resize window for the wizard panel
  if (!onboardingService.isComplete) {
    await windowService.setWindowFrame(100, 200, 320, 380);
  }

  // Restore persisted position (if saved)
  if (settingsService.settings.eyeX >= 0) {
    final s = settingsService.settings;
    // Size depends on saved state
    final w = s.overlayState == HudState.chat ? s.chatWidth
        : s.overlayState == HudState.controls ? 280.0
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
      case 'onToggleTraits':
        wsService.sendCommand('toggle_traits');
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
        ChangeNotifierProvider.value(value: settingsService),
        ChangeNotifierProvider.value(value: wsService),
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
        body: OverlayShell(key: overlayShellKey),
      ),
    );
  }
}
