import 'package:flutter/material.dart';
import '../../core/models/region_highlight.dart';
import '../hud_tooltip.dart';

/// Banner above the chat input shown after tapping a region eye.
///
/// Presents the detected issue and the suggested approach, and lets the user
/// explicitly start the region's agent thread — tapping an eye never
/// auto-runs. Once the thread is started ([threadStarted]) the Run button
/// becomes a thread indicator: the chat input below routes follow-ups to
/// this region's conversation until the banner is dismissed.
/// Mirrors [PermissionBanner]'s compact style.
class RegionActionBanner extends StatelessWidget {
  final RegionHighlight region;
  final int accentColor;
  final bool threadStarted;
  final VoidCallback onRun;
  final VoidCallback onDismiss;

  /// SPIKE (thread terminal): open this region as an interactive agent
  /// terminal instead of a chat thread. Hidden when null (gate off).
  final VoidCallback? onTerminal;

  const RegionActionBanner({
    super.key,
    required this.region,
    required this.accentColor,
    required this.threadStarted,
    required this.onRun,
    required this.onDismiss,
    this.onTerminal,
  });

  String get _runLabel {
    switch (region.action) {
      case 'fix':
        return 'Fix it';
      case 'explain':
        return 'Explain';
      case 'research':
        return 'Research';
      default:
        return 'Help';
    }
  }

  @override
  Widget build(BuildContext context) {
    final accent = Color(accentColor);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: accent.withValues(alpha: 0.35), width: 1),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Text('👁', style: TextStyle(fontSize: 12)),
          ),
          const SizedBox(width: 8),
          // Issue + suggested approach
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  region.issue,
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: accent,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  region.tip,
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 9,
                    color: Colors.white.withValues(alpha: 0.65),
                  ),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          // Run button (explicit thread start) — or thread indicator once
          // started, while the input below routes to this region's thread.
          if (!threadStarted)
            HudTooltip(
              message: 'Ask the agent about this issue (starts a thread for this region)',
              child: GestureDetector(
                onTap: onRun,
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: accent.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '💬 Chat',
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 9,
                        color: accent,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ),
              ),
            )
          else
            HudTooltip(
              message: 'Thread active — messages below go to this region',
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: accent.withValues(alpha: 0.45)),
                ),
                child: Text(
                  '👁 thread',
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 9,
                    color: accent,
                  ),
                ),
              ),
            ),
          if (!threadStarted && onTerminal != null) ...[
            const SizedBox(width: 4),
            HudTooltip(
              message:
                  'Open an interactive terminal with the spawn agent + this region\'s context',
              child: GestureDetector(
                onTap: onTerminal,
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(4),
                      border:
                          Border.all(color: accent.withValues(alpha: 0.45)),
                    ),
                    child: Text(
                      '⌨ Term',
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 9,
                        color: accent,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(width: 6),
          HudTooltip(
            message: 'Dismiss',
            child: GestureDetector(
              onTap: onDismiss,
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Padding(
                  padding: const EdgeInsets.all(2),
                  child: Icon(Icons.close,
                      size: 12, color: Colors.white.withValues(alpha: 0.4)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
