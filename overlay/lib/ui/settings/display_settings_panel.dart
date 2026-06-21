import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../../core/app_control.dart';
import '../../core/constants.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';
import '../../core/services/update_check_service.dart';
import 'package:url_launcher/url_launcher.dart';
import '../hud_tooltip.dart';

/// Compact display-settings popover for font size and accent color.
class DisplaySettingsPanel extends StatelessWidget {
  final VoidCallback onClose;

  const DisplaySettingsPanel({super.key, required this.onClose});

  static const _presetColors = <int>[
    0xFF00FF88, // green (default)
    0xFF00E5FF, // cyan
    0xFFFF6B9D, // pink
    0xFFFFAB00, // amber
    0xFF9D65FF, // purple
    0xFF00BFFF, // blue
    0xFFFF3344, // red
    0xFFFFFFFF, // white
  ];

  static const _sizeLabels = ['S', 'M', 'L'];
  static const _sizeValues = ['small', 'medium', 'large'];

  Future<void> _openSessionLog(BuildContext context) async {
    final ws = context.read<WebSocketService>();
    final error = await openCurrentSessionLog();
    if (error != null) {
      ws.showSystemAlert(error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>();
    final ws = context.watch<WebSocketService>();
    final fontSize = settings.settings.fontSize;
    final accentColor = settings.settings.accentColor;
    final responseSizeIndex = _sizeValues.indexOf(ws.responseSize).clamp(0, 2);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.95),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Color(accentColor).withValues(alpha: 0.3)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            children: [
              Text(
                'DISPLAY',
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 9,
                  color: Colors.white.withValues(alpha: 0.5),
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.5,
                ),
              ),
              const Spacer(),
              HudTooltip(
                message: 'Close',
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: GestureDetector(
                    onTap: onClose,
                    child: Icon(
                      Icons.close,
                      size: 12,
                      color: Colors.white.withValues(alpha: 0.4),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),

          // Font size
          Row(
            children: [
              Text(
                'SIZE',
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 9,
                  color: Colors.white.withValues(alpha: 0.35),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${fontSize.round()}',
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 10,
                  color: Color(accentColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 20,
            child: SliderTheme(
              data: SliderThemeData(
                trackHeight: 2,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 5),
                activeTrackColor: Color(accentColor),
                inactiveTrackColor: Colors.white.withValues(alpha: 0.1),
                thumbColor: Color(accentColor),
                overlayShape: SliderComponentShape.noOverlay,
              ),
              child: Slider(
                value: fontSize,
                min: 8.0,
                max: 24.0,
                onChanged: (v) => settings.setFontSize(v),
              ),
            ),
          ),
          const SizedBox(height: 6),

          // Accent color
          Text(
            'ACCENT',
            style: TextStyle(
              fontFamily: HudConstants.monoFont,
              fontFamilyFallback: HudConstants.monoFontFallbacks,
              fontSize: 9,
              color: Colors.white.withValues(alpha: 0.35),
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _presetColors.map((color) {
              final isSelected = color == accentColor;
              return MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () => settings.setAccentColor(color),
                  child: Container(
                    width: 18,
                    height: 18,
                    decoration: BoxDecoration(
                      color: Color(color),
                      shape: BoxShape.circle,
                      border: isSelected
                          ? Border.all(color: Colors.white, width: 2)
                          : Border.all(
                              color: Colors.white.withValues(alpha: 0.15),
                            ),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 10),

          // Response size
          Row(
            children: [
              Text(
                'RESPONSE',
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 9,
                  color: Colors.white.withValues(alpha: 0.35),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _sizeLabels[responseSizeIndex],
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 10,
                  color: Color(accentColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: 20,
            child: SliderTheme(
              data: SliderThemeData(
                trackHeight: 2,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 5),
                activeTrackColor: Color(accentColor),
                inactiveTrackColor: Colors.white.withValues(alpha: 0.1),
                thumbColor: Color(accentColor),
                overlayShape: SliderComponentShape.noOverlay,
              ),
              child: Slider(
                value: responseSizeIndex.toDouble(),
                min: 0,
                max: 2,
                divisions: 2,
                onChanged: (v) => ws.setResponseSize(_sizeValues[v.round()]),
              ),
            ),
          ),
          const SizedBox(height: 10),

          // Auto-detect issues (Grammarly mode region eyes) toggle
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => settings.setAutoDetectIssues(
                  !settings.settings.autoDetectIssues),
              child: Row(
                children: [
                  Text(
                    'AUTO-DETECT ISSUES',
                    style: TextStyle(
                      fontFamily: HudConstants.monoFont,
                      fontFamilyFallback: HudConstants.monoFontFallbacks,
                      fontSize: 9,
                      color: Colors.white.withValues(alpha: 0.35),
                    ),
                  ),
                  const Spacer(),
                  Icon(
                    settings.settings.autoDetectIssues
                        ? Icons.toggle_on
                        : Icons.toggle_off,
                    size: 22,
                    color: settings.settings.autoDetectIssues
                        ? Color(accentColor)
                        : Colors.white.withValues(alpha: 0.3),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),

          // ChatGPT network harness — exposes the local MCP server over a public
          // tunnel so ChatGPT can reach it. Security-sensitive → off by default.
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () {
                final next = !settings.settings.chatgptHarness;
                settings.setChatgptHarness(next);
                ws.setChatgptHarness(next);
              },
              child: Row(
                children: [
                  Text(
                    'CHATGPT NETWORK HARNESS',
                    style: TextStyle(
                      fontFamily: HudConstants.monoFont,
                      fontFamilyFallback: HudConstants.monoFontFallbacks,
                      fontSize: 9,
                      color: Colors.white.withValues(alpha: 0.35),
                    ),
                  ),
                  const Spacer(),
                  Icon(
                    settings.settings.chatgptHarness
                        ? Icons.toggle_on
                        : Icons.toggle_off,
                    size: 22,
                    color: settings.settings.chatgptHarness
                        ? const Color(0xFFFF6644)
                        : Colors.white.withValues(alpha: 0.3),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 3, right: 24),
            child: Text(
              '⚠ Opens a public tunnel to your local context (screen/audio). '
              'Anyone with the URL could reach it. Enable only while using '
              'ChatGPT, and turn it off when done.',
              style: TextStyle(
                fontFamily: HudConstants.monoFont,
                fontFamilyFallback: HudConstants.monoFontFallbacks,
                fontSize: 8,
                height: 1.3,
                color: const Color(0xFFFF6644).withValues(alpha: 0.85),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Divider(height: 1, color: Colors.white.withValues(alpha: 0.1)),
          const SizedBox(height: 8),

          // OpenRouter API key — editable recovery path (was .env-only, so a
          // wrong key at setup had no graceful fix).
          const _OpenRouterKeyField(),

          // Update available (DMG installs — checked daily against the
          // latest macos-v* release; DMGs have no auto-update)
          if (context.watch<UpdateCheckService>().availableVersion != null) ...[
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: () => launchUrl(
                  Uri.parse(UpdateCheckService.downloadUrl),
                  mode: LaunchMode.externalApplication,
                ),
                child: Row(
                  children: [
                    Icon(Icons.system_update_alt,
                        size: 12, color: Color(accentColor)),
                    const SizedBox(width: 6),
                    Text(
                      'Update available: v${context.watch<UpdateCheckService>().availableVersion} — download',
                      style: TextStyle(
                        fontFamily: HudConstants.monoFont,
                        fontFamilyFallback: HudConstants.monoFontFallbacks,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                        color: Color(accentColor),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],

          // Current session log
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => _openSessionLog(context),
              child: Row(
                children: [
                  Icon(
                    Icons.article_outlined,
                    size: 12,
                    color: Colors.white.withValues(alpha: 0.55),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Open Session Log',
                    style: TextStyle(
                      fontFamily: HudConstants.monoFont,
                      fontFamilyFallback: HudConstants.monoFontFallbacks,
                      fontSize: 10,
                      color: Colors.white.withValues(alpha: 0.7),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),

          // Quit Sinain
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: quitApp,
              child: Row(
                children: [
                  const Icon(
                    Icons.power_settings_new,
                    size: 12,
                    color: Color(0xFFFF6B6B),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Quit Sinain',
                    style: TextStyle(
                      fontFamily: HudConstants.monoFont,
                      fontFamilyFallback: HudConstants.monoFontFallbacks,
                      fontSize: 10,
                      color: Colors.white.withValues(alpha: 0.7),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Editable OpenRouter API key. Merges `OPENROUTER_API_KEY` into ~/.sinain/.env
/// (preserving other vars) and restarts the backend so the new key takes effect
/// — the graceful recovery for a wrong key entered during setup.
class _OpenRouterKeyField extends StatefulWidget {
  const _OpenRouterKeyField();

  @override
  State<_OpenRouterKeyField> createState() => _OpenRouterKeyFieldState();
}

class _OpenRouterKeyFieldState extends State<_OpenRouterKeyField> {
  final _ctl = TextEditingController();
  String? _status;
  bool _saving = false;

  String? get _envPath {
    final home = Platform.environment['HOME'];
    return home == null ? null : '$home/.sinain/.env';
  }

  @override
  void initState() {
    super.initState();
    final p = _envPath;
    if (p != null && File(p).existsSync()) {
      for (final l in File(p).readAsLinesSync()) {
        if (l.startsWith('OPENROUTER_API_KEY=')) {
          _ctl.text = l.substring('OPENROUTER_API_KEY='.length).trim();
        }
      }
    }
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final p = _envPath;
    if (p == null) {
      setState(() => _status = 'no HOME');
      return;
    }
    setState(() {
      _saving = true;
      _status = null;
    });
    try {
      final f = File(p);
      final key = _ctl.text.trim();
      final lines = await f.exists() ? await f.readAsLines() : <String>[];
      var found = false;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('OPENROUTER_API_KEY=')) {
          lines[i] = 'OPENROUTER_API_KEY=$key';
          found = true;
        }
      }
      if (!found) lines.add('OPENROUTER_API_KEY=$key');
      await f.parent.create(recursive: true);
      await f.writeAsString('${lines.join('\n')}\n');
      await const MethodChannel('sinain_hud/backend').invokeMethod('restart');
      if (mounted) setState(() => _status = 'Saved · restarting backend');
    } catch (e) {
      if (mounted) setState(() => _status = 'Failed: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  TextStyle _mono(double alpha, double size) => TextStyle(
        fontFamily: HudConstants.monoFont,
        fontFamilyFallback: HudConstants.monoFontFallbacks,
        fontSize: size,
        color: Colors.white.withValues(alpha: alpha),
      );

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('OPENROUTER KEY', style: _mono(0.35, 9)),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: SizedBox(
                height: 26,
                child: TextField(
                  controller: _ctl,
                  obscureText: true,
                  style: _mono(1.0, 10),
                  decoration: InputDecoration(
                    isDense: true,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    hintText: 'sk-or-…',
                    hintStyle: _mono(0.25, 10),
                    filled: true,
                    fillColor: Colors.white.withValues(alpha: 0.06),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(4),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: _saving ? null : _save,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(_saving ? '…' : 'SAVE',
                      style: _mono(0.9, 9).copyWith(fontWeight: FontWeight.bold)),
                ),
              ),
            ),
          ],
        ),
        if (_status != null)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(_status!, style: _mono(0.5, 8)),
          ),
        const SizedBox(height: 10),
      ],
    );
  }
}
