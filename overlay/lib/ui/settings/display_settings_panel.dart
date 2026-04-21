import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/constants.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';
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
        border: Border.all(
          color: Color(accentColor).withValues(alpha: 0.3),
        ),
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
                    child: Icon(Icons.close, size: 12,
                        color: Colors.white.withValues(alpha: 0.4)),
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
                              color: Colors.white.withValues(alpha: 0.15)),
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
        ],
      ),
    );
  }
}
