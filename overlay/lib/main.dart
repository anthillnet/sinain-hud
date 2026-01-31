import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'core/constants.dart';
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
