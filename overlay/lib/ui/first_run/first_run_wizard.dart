import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/services/first_run_service.dart';
import '../../core/services/window_service.dart';
import 'install_tier.dart';
import 'tier_selection_view.dart';

/// SEED-001 Stage 5 — packaged-app first-run wizard.
///
/// welcome → tier picker → config (API key / local note) → writes ~/.sinain/.env
/// and restarts the backend, then calls [onComplete] to enter the normal HUD.
class FirstRunWizard extends StatefulWidget {
  const FirstRunWizard({
    super.key,
    required this.service,
    required this.onComplete,
  });

  final FirstRunService service;
  final VoidCallback onComplete;

  @override
  State<FirstRunWizard> createState() => _FirstRunWizardState();
}

enum _Step { welcome, tier, config, finishing }

class _FirstRunWizardState extends State<FirstRunWizard> {
  static const Color _accent = Color(0xFF00FF88);

  _Step _step = _Step.welcome;
  InstallTier? _tier;
  final TextEditingController _keyController = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _keyController.dispose();
    super.dispose();
  }

  bool get _tierNeedsKey =>
      _tier == InstallTier.cloudOnly || _tier == InstallTier.cloudPlusLocalWhisper;

  Future<void> _finish() async {
    if (_tierNeedsKey && _keyController.text.trim().isEmpty) {
      setState(() => _error = 'An OpenRouter API key is required for this tier.');
      return;
    }
    setState(() {
      _error = null;
      _step = _Step.finishing;
    });
    try {
      await widget.service.completeSetup(
        _tier!,
        openRouterKey: _tierNeedsKey ? _keyController.text : null,
      );
      widget.onComplete();
    } catch (e) {
      setState(() {
        _error = 'Setup failed: $e';
        _step = _Step.config;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // Drag anywhere on the panel to move the (frameless, non-system-movable)
    // window — mirrors eye_widget / overlay_shell. Taps still reach buttons.
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanUpdate: (d) => context
          .read<WindowService>()
          .moveWindowBy(d.delta.dx, -d.delta.dy),
      child: Container(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.94),
        borderRadius: BorderRadius.circular(12),
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'SINAIN',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.bold,
              color: _accent,
              letterSpacing: 4,
            ),
          ),
          const SizedBox(height: 16),
          Flexible(child: SingleChildScrollView(child: _buildStep())),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(
              _error!,
              style: const TextStyle(fontSize: 11, color: Color(0xFFFF6B6B)),
            ),
          ],
        ],
      ),
      ),
    );
  }

  Widget _buildStep() {
    switch (_step) {
      case _Step.welcome:
        return _welcome();
      case _Step.tier:
        return _tierStep();
      case _Step.config:
        return _configStep();
      case _Step.finishing:
        return _finishing();
    }
  }

  Widget _welcome() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'A private AI overlay that watches your screen and audio, and is '
          'invisible to screen capture.',
          style: TextStyle(
            fontSize: 12,
            height: 1.4,
            color: Colors.white.withValues(alpha: 0.8),
          ),
        ),
        const SizedBox(height: 18),
        _primaryButton('Get started', () => setState(() => _step = _Step.tier)),
      ],
    );
  }

  Widget _tierStep() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TierSelectionView(
          selected: _tier,
          onSelected: (t) => setState(() => _tier = t),
        ),
        const SizedBox(height: 14),
        _primaryButton(
          'Continue',
          _tier == null ? null : () => setState(() => _step = _Step.config),
        ),
      ],
    );
  }

  Widget _configStep() {
    final needsKey = _tierNeedsKey;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (needsKey) ...[
          Text(
            'Paste your OpenRouter API key',
            style: TextStyle(
              fontSize: 12,
              color: Colors.white.withValues(alpha: 0.85),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _keyController,
            obscureText: true,
            autofocus: true,
            style: const TextStyle(fontSize: 12, color: Colors.white),
            decoration: InputDecoration(
              hintText: 'sk-or-...',
              hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.3)),
              isDense: true,
              enabledBorder: OutlineInputBorder(
                borderSide:
                    BorderSide(color: Colors.white.withValues(alpha: 0.2)),
              ),
              focusedBorder: const OutlineInputBorder(
                borderSide: BorderSide(color: _accent),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Get a free key at openrouter.ai',
            style: TextStyle(
              fontSize: 10,
              color: Colors.white.withValues(alpha: 0.4),
            ),
          ),
        ] else ...[
          Text(
            'Full local mode needs Ollama running with the models pulled:\n'
            '  ollama pull phi4-mini qwen2.5vl:7b\n'
            'and whisper.cpp installed. Zero data leaves your Mac.',
            style: TextStyle(
              fontSize: 11,
              height: 1.4,
              color: Colors.white.withValues(alpha: 0.75),
            ),
          ),
        ],
        const SizedBox(height: 16),
        _primaryButton('Finish setup', _finish),
      ],
    );
  }

  Widget _finishing() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 8),
        const SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: _accent),
        ),
        const SizedBox(height: 14),
        Text(
          'Writing config and starting the backend…',
          style: TextStyle(
            fontSize: 11,
            color: Colors.white.withValues(alpha: 0.7),
          ),
        ),
      ],
    );
  }

  Widget _primaryButton(String label, VoidCallback? onTap) {
    final enabled = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: enabled
              ? _accent.withValues(alpha: 0.15)
              : Colors.white.withValues(alpha: 0.04),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: enabled
                ? _accent
                : Colors.white.withValues(alpha: 0.12),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: enabled ? _accent : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
  }
}
