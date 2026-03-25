import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'core/constants.dart';
import 'core/services/settings_service.dart';
import 'core/services/websocket_service.dart';
import 'core/services/window_service.dart';
import 'ui/overlay_shell.dart';

/// Global key for OverlayShell so hotkey handler can trigger state changes.
final overlayShellKey = GlobalKey<OverlayShellState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize services
  final windowService = WindowService();
  final settingsService = SettingsService();
  await settingsService.init();

  final wsService = WebSocketService(url: settingsService.settings.wsUrl);

  // Configure native window
  await windowService.setTransparent();
  await windowService.setPrivacyMode(true);
  await windowService.setAlwaysOnTop(true);

  // Restore persisted eye position (if saved)
  if (settingsService.settings.eyeX >= 0) {
    await windowService.setWindowFrame(
      settingsService.settings.eyeX,
      settingsService.settings.eyeY,
      48,
      48,
    );
  }

  // Listen for hotkey events from native side
  const hotkeyChannel = MethodChannel('sinain_hud/hotkeys');
  hotkeyChannel.setMethodCallHandler((call) async {
    switch (call.method) {
      case 'onToggleVisibility':
        final visible = call.arguments as bool;
        overlayShellKey.currentState?.toggleVisibility(visible);
      case 'onQuit':
        wsService.disconnect();
      case 'onToggleChat':
        overlayShellKey.currentState?.toggleChat();
    }
  });

  // Connect WebSocket
  wsService.connect();

  runApp(
    MultiProvider(
      providers: [
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
