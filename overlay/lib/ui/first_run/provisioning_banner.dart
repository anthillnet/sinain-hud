import 'package:flutter/material.dart';

import '../../core/services/provisioning_service.dart';
import 'wizard_theme.dart';

/// SEED-001 — compact "Setting up Sinain" panel shown over the HUD while
/// local-mode components download (Python / speech model / local SLMs).
/// Recreated from the Claude Design handoff (`Setup Wizard.dc.html`, Section C):
/// a 360×230 dark card with per-item progress rows. Reads live state from
/// [ProvisioningService]; draggable so it never traps the user. Non-blocking —
/// the HUD is already usable underneath.
class ProvisioningBanner extends StatelessWidget {
  const ProvisioningBanner({
    super.key,
    required this.service,
    this.onDrag,
  });

  final ProvisioningService service;
  final ValueChanged<DragUpdateDetails>? onDrag;

  static const Color _err = Color(0xFFFF6B6B);

  @override
  Widget build(BuildContext context) {
    final items = service.items;
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanUpdate: onDrag,
      child: Container(
        width: 360,
        height: 230,
        decoration: BoxDecoration(
          color: kWizardCardBg,
          borderRadius: BorderRadius.circular(12),
          boxShadow: kWizardCardShadow,
        ),
        clipBehavior: Clip.antiAlias,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Row(
              children: [
                WizardEyeGlyph(size: 18, strokeWidth: 3),
                SizedBox(width: 9),
                Text(
                  'Setting up Sinain',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final item in items) _row(item),
                  ],
                ),
              ),
            ),
            Container(
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: kWizardHairline)),
              ),
              padding: const EdgeInsets.only(top: 10),
              child: const Text(
                'You can keep working — this runs in the background and only '
                'happens once.',
                style: TextStyle(fontSize: 11, height: 1.36, color: kWizardTextDim),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(ProvisioningItem item) {
    final done = item.state == 'done';
    final String status;
    final Color statusColor;
    if (item.error) {
      status = 'Failed';
      statusColor = _err;
    } else if (done) {
      status = 'Done';
      statusColor = kWizardGreen;
    } else {
      status = item.pct != null ? '${item.pct}%' : '…';
      statusColor = kWizardTextMuted;
    }

    final double? value = done
        ? 1.0
        : item.pct != null
            ? item.pct! / 100.0
            : null; // indeterminate

    return Padding(
      padding: const EdgeInsets.only(bottom: 11),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  item.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: kWizardCodeText),
                ),
              ),
              const SizedBox(width: 8),
              Text(status, style: TextStyle(fontSize: 11, color: statusColor)),
            ],
          ),
          const SizedBox(height: 5),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              minHeight: 4,
              value: value,
              backgroundColor: const Color(0x14FFFFFF),
              valueColor: AlwaysStoppedAnimation(
                item.error ? _err : kWizardGreen,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
