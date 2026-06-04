import 'package:flutter/material.dart';

import 'install_tier.dart';

/// SEED-001 Phase 5 — tier picker step of the first-run wizard (SCAFFOLD).
///
/// Presents T0 / T1 / T2 with plain-language tradeoffs. This is a visual stub:
/// it renders and reports the chosen tier via [onSelected], but the downstream
/// steps (permissions → tier-config → Ollama detection → model download →
/// smoke test → write .env) are not implemented yet. See
/// docs/dmg-distribution-spec.md §6 and overlay/lib/ui/first_run/README.md.
class TierSelectionView extends StatelessWidget {
  const TierSelectionView({
    super.key,
    this.selected,
    required this.onSelected,
  });

  /// Currently highlighted tier, or null if none chosen yet.
  final InstallTier? selected;

  /// Called when the user taps a tier card.
  final ValueChanged<InstallTier> onSelected;

  static const Color _accent = Color(0xFF00FF88);

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Choose how Sinain runs',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: Colors.white.withValues(alpha: 0.9),
          ),
        ),
        const SizedBox(height: 12),
        for (final info in InstallTierInfo.all) ...[
          _TierCard(
            info: info,
            isSelected: info.tier == selected,
            onTap: () => onSelected(info.tier),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _TierCard extends StatelessWidget {
  const _TierCard({
    required this.info,
    required this.isSelected,
    required this.onTap,
  });

  final InstallTierInfo info;
  final bool isSelected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final border = isSelected
        ? TierSelectionView._accent
        : Colors.white.withValues(alpha: 0.12);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: isSelected ? 0.06 : 0.03),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: border, width: isSelected ? 1.5 : 1),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  info.shortName,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: TierSelectionView._accent,
                    letterSpacing: 1.5,
                  ),
                ),
                Text(
                  info.approxDiskGb == 0
                      ? 'no download'
                      : '~${info.approxDiskGb.toStringAsFixed(0)} GB',
                  style: TextStyle(
                    fontSize: 10,
                    color: Colors.white.withValues(alpha: 0.4),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              info.tagline,
              style: TextStyle(
                fontSize: 11,
                color: Colors.white.withValues(alpha: 0.75),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Cloud: ${info.cloudEgress}',
              style: TextStyle(
                fontSize: 10,
                color: Colors.white.withValues(alpha: 0.45),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
