import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'core/constants.dart';
import 'core/models/hud_settings.dart';
import 'core/services/settings_service.dart';
import 'core/services/websocket_service.dart';
import 'core/services/window_service.dart';
import 'ui/hud_shell.dart';

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
  await windowService.setClickThrough(true);

  // Listen for hotkey events from native side
  const hotkeyChannel = MethodChannel('sinain_hud/hotkeys');
  hotkeyChannel.setMethodCallHandler((call) async {
    switch (call.method) {
      case 'onToggleVisibility':
        // Visibility is handled natively via orderFront/orderOut.
        // Sync the display mode so the UI can reflect it.
        final visible = call.arguments as bool;
        if (!visible) {
          await settingsService.setDisplayMode(DisplayMode.hidden);
        } else if (settingsService.settings.displayMode == DisplayMode.hidden) {
          await settingsService.setDisplayMode(DisplayMode.feed);
        }
      case 'onToggleClickThrough':
        await settingsService.toggleClickThrough();
      case 'onCycleMode':
        final modeName = call.arguments as String;
        final mode = DisplayMode.values.firstWhere(
          (m) => m.name == modeName,
          orElse: () => DisplayMode.feed,
        );
        await settingsService.setDisplayMode(mode);
      case 'onPanicHide':
        await settingsService.setDisplayMode(DisplayMode.hidden);
        await settingsService.setClickThrough(true);
        await settingsService.setPrivacyMode(true);
      case 'onToggleAudio':
        wsService.sendCommand('toggle_audio');
      case 'onSwitchAudioDevice':
        wsService.sendCommand('switch_device');
      case 'onToggleAudioFeed':
        wsService.toggleAudioFeed();
      case 'onScrollFeed':
        wsService.scrollFeed(call.arguments as String);
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
      home: const Scaffold(
        backgroundColor: Colors.transparent,
        body: HudShell(),
      ),
    );
  }
}
