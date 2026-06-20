import 'package:flutter/material.dart';

import 'install_tier.dart';
import 'wizard_theme.dart';

/// Tier picker step of the first-run wizard, recreated from the Claude Design
/// handoff (`Setup Wizard.dc.html`). Presents Cloud / Hybrid / Private as
/// selectable cards — the chosen one gets the Ring UI green border, a tinted
/// fill, and a check. Reports the choice via [onSelected]; the wizard owns the
/// downstream config / permission / write-.env steps.
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

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final info in InstallTierInfo.all) ...[
          _TierCard(
            info: info,
            isSelected: info.tier == selected,
            onTap: () => onSelected(info.tier),
          ),
          if (info != InstallTierInfo.all.last) const SizedBox(height: 7),
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

  String get _sizeLabel {
    final gb = info.approxDiskGb;
    if (gb == 0) return 'no download';
    final n = gb == gb.roundToDouble() ? gb.toStringAsFixed(0) : gb.toString();
    return '~$n GB';
  }

  /// Privacy highlight — the Hybrid tier keeps audio on-device, which is its
  /// headline tradeoff in the design.
  String? get _highlight => info.tier == InstallTier.cloudPlusLocalWhisper
      ? 'Your audio never leaves the device.'
      : null;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        decoration: BoxDecoration(
          color: isSelected ? const Color(0x1F1F8039) : null,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: isSelected ? kWizardGreen : const Color(0x1FFFFFFF),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  info.shortName,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                if (isSelected) ...[
                  const SizedBox(width: 6),
                  const Padding(
                    padding: EdgeInsets.only(top: 1),
                    child: WizardCheck(size: 13),
                  ),
                ],
                const Spacer(),
                Text(
                  _sizeLabel,
                  style: const TextStyle(fontSize: 11, color: kWizardTextDim),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              info.tagline,
              style: const TextStyle(
                fontSize: 11,
                height: 1.36,
                color: kWizardTextMuted,
              ),
            ),
            if (_highlight != null) ...[
              const SizedBox(height: 5),
              Text(
                _highlight!,
                style: const TextStyle(fontSize: 11, color: kWizardGreen),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
