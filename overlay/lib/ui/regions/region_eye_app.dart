import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../eye/eye_widget.dart';

/// Secondary window app for a region highlight eye.
/// Renders the animated sinain EyeWidget.
/// Window configuration (size, position, transparency) handled by native Swift
/// via FlutterMultiWindowPlugin.setOnWindowCreatedCallback in AppDelegate.
/// Communication via sinain_hud/region_window method channel.
class RegionEyeApp extends StatefulWidget {
  final String args;

  const RegionEyeApp({super.key, required this.args});

  @override
  State<RegionEyeApp> createState() => _RegionEyeAppState();
}

class _RegionEyeAppState extends State<RegionEyeApp> {
  static const _channel = MethodChannel('sinain_hud/region_window');

  late final Map<String, dynamic> _regionData;
  bool _initialized = false;
  bool _tapCooldown = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      _regionData = jsonDecode(widget.args) as Map<String, dynamic>;
      debugPrint('[RegionEye] initialized: issue=${_regionData['issue']}');
    } catch (e) {
      debugPrint('[RegionEye] init failed: $e');
      _regionData = {'issue': 'unknown', 'tip': '', 'action': 'help'};
    }

    // Set position and show via native channel (Swift configures the NSWindow)
    final x = (_regionData['x'] as num?)?.toDouble() ?? 100.0;
    final y = (_regionData['y'] as num?)?.toDouble() ?? 100.0;
    try {
      await _channel.invokeMethod('setPosition', {'x': x, 'y': y});
      await _channel.invokeMethod('show');
    } catch (e) {
      debugPrint('[RegionEye] window config failed: $e');
    }

    if (mounted) setState(() => _initialized = true);
  }

  void _onDragStart() {
    try {
      _channel.invokeMethod('beginDrag');
    } catch (e) {
      debugPrint('[RegionEye] drag failed: $e');
    }
  }

  void _onTap() {
    if (_tapCooldown) return;
    _tapCooldown = true;
    // Debounce: ignore taps for 2s after a tap
    Future.delayed(const Duration(seconds: 2), () => _tapCooldown = false);

    debugPrint('[RegionEye] tapped: ${_regionData['issue']}');
    // Send tap event to main window via native channel (Swift forwards it)
    try {
      _channel.invokeMethod('onTap', {
        'id': _regionData['id'] ?? 'unknown',
        'issue': _regionData['issue'] ?? '',
        'tip': _regionData['tip'] ?? '',
        'action': _regionData['action'] ?? 'help',
      });
    } catch (e) {
      debugPrint('[RegionEye] failed to send tap: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.transparent,
        canvasColor: Colors.transparent,
      ),
      home: Scaffold(
        backgroundColor: Colors.transparent,
        body: _initialized
            ? EyeWidget(
                onTap: _onTap,
                onDragStart: _onDragStart,
                pupilDilation: 0.4,
                eyeColor: const Color(0xFF00FF88),
              )
            : const SizedBox.shrink(),
      ),
    );
  }
}
