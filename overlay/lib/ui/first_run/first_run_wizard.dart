import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_control.dart';
import '../../core/services/first_run_service.dart';
import '../../core/services/window_service.dart';
import 'install_tier.dart';
import 'tier_selection_view.dart';
import 'wizard_theme.dart';

/// SEED-001 Stage 5 — packaged-app first-run wizard.
///
/// A 340×420 frameless, drag-anywhere panel shown after first launch, recreated
/// from the Claude Design handoff (`Setup Wizard.dc.html`). The flow is:
///
///   welcome → choose tier → config (key / local note) → Screen Recording
///   permission (pre-warn → waiting → granted) → finishing
///
/// On finish it writes `~/.sinain/.env` and relaunches the backend, then the
/// `needsSetup` flip rebuilds `main.dart` into the provisioning banner / feature
/// tour / HUD. The visual language (Ring UI green on a dark card, the eye glyph,
/// progress dots) is shared with the feature tour via `wizard_theme.dart`.
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

/// Top-level wizard step. The dot index is `_Step.index` (welcome=0 … finish=4).
enum _Step { welcome, tier, config, permission, finishing }

/// Sub-state of the Screen Recording permission step (Section B of the design).
enum _PermPhase { prewarn, waiting, granted }

class _FirstRunWizardState extends State<FirstRunWizard> {
  static final bool _isMacOS = Platform.isMacOS;

  _Step _step = _Step.welcome;
  _PermPhase _permPhase = _PermPhase.prewarn;
  InstallTier? _tier;
  final TextEditingController _keyController = TextEditingController();
  final TextEditingController _cerebrasController = TextEditingController();
  String? _error;
  Timer? _permPoll;

  @override
  void initState() {
    super.initState();
    // Resume at the permission step if a checkpoint survived a macOS
    // quit-and-reopen triggered by granting Screen Recording (see
    // FirstRunService.savePermissionCheckpoint). Restore the tier + key the
    // user already entered so they don't redo the flow.
    if (widget.service.resumeAtPermission && widget.service.resumeTier != null) {
      _tier = widget.service.resumeTier;
      _keyController.text = widget.service.resumeKey ?? '';
      _cerebrasController.text = widget.service.resumeCerebrasKey ?? '';
      _step = _Step.permission;
      // After the relaunch the grant is usually live — re-check immediately.
      WidgetsBinding.instance.addPostFrameCallback((_) => _enterPermission());
    }
  }

  @override
  void dispose() {
    _permPoll?.cancel();
    _keyController.dispose();
    _cerebrasController.dispose();
    super.dispose();
  }

  bool get _tierNeedsKey =>
      _tier == InstallTier.cloudOnly ||
      _tier == InstallTier.cloudPlusLocalWhisper;

  // ── Navigation ─────────────────────────────────────────────────────────────

  void _goToConfig() {
    setState(() {
      _error = null;
      _step = _Step.config;
    });
  }

  void _configContinue() {
    if (_tierNeedsKey && _keyController.text.trim().isEmpty) {
      setState(() => _error = 'An OpenRouter API key is required for this tier.');
      return;
    }
    setState(() {
      _error = null;
      _step = _Step.permission;
      _permPhase = _PermPhase.prewarn;
    });
  }

  /// Enter / re-check the permission step. Used on first arrival, on resume
  /// after a macOS relaunch, and as the poll body while waiting.
  Future<void> _enterPermission() async {
    if (!_isMacOS) {
      // No native Screen Recording gate off-macOS — treat as granted.
      setState(() => _permPhase = _PermPhase.granted);
      return;
    }
    final granted = await context.read<WindowService>().screenRecordingStatus();
    if (!mounted) return;
    if (granted) {
      _permPoll?.cancel();
      setState(() => _permPhase = _PermPhase.granted);
    }
  }

  /// "Allow Screen Recording" — persist a checkpoint, then trigger the macOS
  /// prompt. If already granted, jump to confirmation; otherwise wait + poll.
  Future<void> _requestPermission() async {
    // Capture the service before any await so we don't reach through `context`
    // across an async gap.
    final ws = context.read<WindowService>();
    await widget.service.savePermissionCheckpoint(
      _tier!,
      openRouterKey: _tierNeedsKey ? _keyController.text.trim() : null,
      cerebrasKey: _tierNeedsKey ? _cerebrasController.text.trim() : null,
    );
    final granted = await ws.requestScreenRecording();
    if (!mounted) return;
    if (granted) {
      setState(() => _permPhase = _PermPhase.granted);
    } else {
      setState(() => _permPhase = _PermPhase.waiting);
      _startPermPoll();
    }
  }

  void _startPermPoll() {
    _permPoll?.cancel();
    _permPoll = Timer.periodic(
      const Duration(milliseconds: 1500),
      (_) => _enterPermission(),
    );
  }

  Future<void> _finish() async {
    _permPoll?.cancel();
    setState(() {
      _error = null;
      _step = _Step.finishing;
    });
    try {
      await widget.service.completeSetup(
        _tier!,
        openRouterKey: _tierNeedsKey ? _keyController.text : null,
        cerebrasKey: _tierNeedsKey ? _cerebrasController.text : null,
      );
      widget.onComplete();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Setup failed: $e';
        _step = _Step.permission;
        _permPhase = _PermPhase.granted;
      });
    }
  }

  // ── Window drag ──────────────────────────────────────────────────────────
  // Mirror the HUD / feature tour: on macOS hand off to a native OS-level drag
  // (smooth), and only fall back to per-delta moveWindowBy off-macOS (laggy).
  void _onDragStart(DragStartDetails _) {
    if (_isMacOS) context.read<WindowService>().beginNativeDrag();
  }

  void _onDragUpdate(DragUpdateDetails d) {
    if (_isMacOS) return; // native handles it
    context.read<WindowService>().moveWindowBy(d.delta.dx, -d.delta.dy);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    // Drag anywhere on the panel to move the frameless window — taps still
    // reach the buttons / text field (pan vs tap).
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: _onDragStart,
      onPanUpdate: _onDragUpdate,
      child: Container(
        width: 340,
        height: 420,
        decoration: BoxDecoration(
          color: kWizardCardBg,
          borderRadius: BorderRadius.circular(12),
          boxShadow: kWizardCardShadow,
        ),
        clipBehavior: Clip.antiAlias,
        padding: const EdgeInsets.fromLTRB(26, 24, 26, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const WizardWordmark(),
            const SizedBox(height: 12),
            WizardProgressDots(active: _step.index),
            const SizedBox(height: 16),
            Expanded(child: _buildStep()),
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
      case _Step.permission:
        return _permissionStep();
      case _Step.finishing:
        return _finishing();
    }
  }

  // ── Step 1 · Welcome ─────────────────────────────────────────────────────────

  Widget _welcome() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Center(
            child: Stack(
              alignment: Alignment.center,
              children: [
                // Concentric rings behind the eye.
                _ring(130, const Color(0x2E1F8039)),
                _ring(188, const Color(0x1A1F8039)),
                const Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    WizardEyeGlyph(size: 64),
                    SizedBox(height: 22),
                    SizedBox(
                      width: 250,
                      child: Text(
                        'A private AI overlay that watches your screen and '
                        'audio — and stays invisible to screen capture.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 14,
                          height: 1.43,
                          color: kWizardTextMuted,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        WizardButton(
          label: 'Get started',
          onTap: () => setState(() => _step = _Step.tier),
        ),
        const SizedBox(height: 12),
        const Center(child: WizardTextLink(label: 'Quit', onTap: quitApp)),
      ],
    );
  }

  Widget _ring(double d, Color color) => Container(
        width: d,
        height: d,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: color),
        ),
      );

  // ── Step 2 · Choose tier ─────────────────────────────────────────────────────

  Widget _tierStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Choose how Sinain runs',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 12),
                TierSelectionView(
                  selected: _tier,
                  onSelected: (t) => setState(() => _tier = t),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        WizardButton(
          label: 'Continue',
          onTap: _tier == null ? null : _goToConfig,
        ),
        const SizedBox(height: 10),
        const Center(child: WizardTextLink(label: 'Quit', onTap: quitApp)),
      ],
    );
  }

  // ── Step 3 · Config ──────────────────────────────────────────────────────────

  Widget _configStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: _tierNeedsKey ? _cloudConfig() : _privateConfig(),
          ),
        ),
        if (_error != null) ...[
          Text(
            _error!,
            style: const TextStyle(fontSize: 11, color: Color(0xFFFF6B6B)),
          ),
          const SizedBox(height: 8),
        ],
        WizardButton(label: 'Continue', onTap: _configContinue),
        const SizedBox(height: 12),
        const Center(child: WizardTextLink(label: 'Quit', onTap: quitApp)),
      ],
    );
  }

  Widget _cloudConfig() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Paste your OpenRouter API key',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 6),
        const Text.rich(
          TextSpan(
            children: [
              TextSpan(text: 'Stored locally in '),
              TextSpan(
                text: '~/.sinain/.env',
                style: TextStyle(fontFamily: 'monospace'),
              ),
              TextSpan(text: '. Never sent anywhere but OpenRouter.'),
            ],
          ),
          style: TextStyle(fontSize: 12, height: 1.33, color: kWizardTextMuted),
        ),
        const SizedBox(height: 14),
        // Key field — dark panel with a green glow border, monospace text.
        Container(
          height: 36,
          decoration: BoxDecoration(
            color: kWizardPanel,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: kWizardGreen),
            boxShadow: const [
              BoxShadow(color: Color(0x661F8039), blurRadius: 0, spreadRadius: 1),
            ],
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.centerLeft,
          child: TextField(
            controller: _keyController,
            obscureText: true,
            autofocus: true,
            cursorColor: kWizardGreen,
            cursorWidth: 1,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 13,
              color: Colors.white,
              letterSpacing: 0.6,
            ),
            decoration: const InputDecoration(
              isDense: true,
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
              hintText: 'sk-or-…',
              hintStyle: TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                color: kWizardTextDim,
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        const Text.rich(
          TextSpan(
            children: [
              TextSpan(text: 'Get a free key at '),
              TextSpan(
                text: 'openrouter.ai',
                style: TextStyle(color: kWizardGreen),
              ),
            ],
          ),
          style: TextStyle(fontSize: 12, color: kWizardTextDim),
        ),
        const SizedBox(height: 18),
        // Optional Cerebras key — powers the burst lane: instant context
        // cards on Save/Call, range previews, and voice-call seeds. The
        // wizard works without it; those features simply stay off.
        const Text(
          'Cerebras API key · optional',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Powers instant context cards (Save / Call AI) and call briefs. '
          'Skip it and those cards stay off.',
          style: TextStyle(fontSize: 11, height: 1.33, color: kWizardTextMuted),
        ),
        const SizedBox(height: 8),
        Container(
          height: 32,
          decoration: BoxDecoration(
            color: kWizardPanel,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: kWizardHairline),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.centerLeft,
          child: TextField(
            controller: _cerebrasController,
            obscureText: true,
            cursorColor: kWizardGreen,
            cursorWidth: 1,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 12,
              color: Colors.white,
              letterSpacing: 0.6,
            ),
            decoration: const InputDecoration(
              isDense: true,
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
              hintText: 'csk-… (cloud.cerebras.ai)',
              hintStyle: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                color: kWizardTextDim,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _privateConfig() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Full local mode',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          'No key needed. Make sure Ollama is running with the models pulled, '
          'and whisper.cpp installed.',
          style: TextStyle(fontSize: 12, height: 1.33, color: kWizardTextMuted),
        ),
        const SizedBox(height: 12),
        Container(
          decoration: BoxDecoration(
            color: kWizardCodeBg,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: kWizardHairline),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Pull the models',
                style: TextStyle(fontSize: 11, color: kWizardTextDim),
              ),
              SizedBox(height: 5),
              Text(
                'ollama pull phi4-mini qwen2.5vl:7b',
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  height: 1.4,
                  color: kWizardCodeText,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        const Row(
          children: [
            Icon(Icons.lock_outline, size: 14, color: kWizardGreen),
            SizedBox(width: 7),
            Text(
              'Zero data leaves your Mac.',
              style: TextStyle(fontSize: 12, color: kWizardGreen),
            ),
          ],
        ),
      ],
    );
  }

  // ── Step 4 · Screen Recording permission ─────────────────────────────────────

  Widget _permissionStep() {
    switch (_permPhase) {
      case _PermPhase.prewarn:
        return _permPrewarn();
      case _PermPhase.waiting:
        return _permWaiting();
      case _PermPhase.granted:
        return _permGranted();
    }
  }

  Widget _permPrewarn() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(height: 2),
                const Center(child: WizardEyeGlyph(size: 46)),
                const SizedBox(height: 12),
                const Text(
                  'One quick permission',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Sinain reads your screen to offer help in context, and hears '
                  'system audio the same way. macOS will ask you to allow Screen '
                  'Recording.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 13, height: 1.38, color: kWizardTextMuted),
                ),
                const SizedBox(height: 14),
                // Helper warning — the system prompt names the capture helper.
                Container(
                  decoration: BoxDecoration(
                    color: const Color(0x1AE56D17),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: EdgeInsets.only(top: 1),
                        child: Icon(Icons.warning_amber_rounded,
                            size: 14, color: kWizardOrange),
                      ),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(text: 'The system prompt will say '),
                              TextSpan(
                                text: '“sck-capture”',
                                style: TextStyle(fontFamily: 'monospace'),
                              ),
                              TextSpan(
                                  text: ' — that’s Sinain’s capture helper.'),
                            ],
                          ),
                          style: TextStyle(
                              fontSize: 11, height: 1.36, color: kWizardCodeText),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        WizardButton(label: 'Allow Screen Recording', onTap: _requestPermission),
        const SizedBox(height: 12),
        Center(child: WizardTextLink(label: 'Do this later', onTap: _finish)),
      ],
    );
  }

  Widget _permWaiting() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Row(
                  children: [
                    SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: kWizardGreen),
                    ),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Waiting for permission',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                const Text(
                  'In System Settings → Privacy & Security → Screen Recording, '
                  'turn on Sinain.',
                  style: TextStyle(
                      fontSize: 12, height: 1.42, color: kWizardTextMuted),
                ),
                const SizedBox(height: 10),
                // Faux Settings row mirroring what the user will see + toggle.
                Container(
                  decoration: BoxDecoration(
                    color: kWizardPanel,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: const Color(0x1AFFFFFF)),
                  ),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
                  child: Row(
                    children: [
                      const WizardEyeGlyph(size: 20, strokeWidth: 3),
                      const SizedBox(width: 10),
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('Sinain',
                                style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w500,
                                    color: Colors.white)),
                            Text('listed as “sck-capture”',
                                style: TextStyle(
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    color: kWizardTextDim)),
                          ],
                        ),
                      ),
                      // toggle (on)
                      Container(
                        width: 34,
                        height: 19,
                        decoration: BoxDecoration(
                          color: kWizardGreen,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Stack(children: [
                          Positioned(
                            top: 2,
                            left: 17,
                            child: Container(
                              width: 15,
                              height: 15,
                              decoration: const BoxDecoration(
                                  color: Colors.white, shape: BoxShape.circle),
                            ),
                          ),
                        ]),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        WizardButton(
          label: 'Open System Settings',
          onTap: () =>
              context.read<WindowService>().openScreenRecordingSettings(),
        ),
        const SizedBox(height: 12),
        const Text(
          'Sinain continues on its own once it’s enabled. macOS may ask to '
          'relaunch.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 11, height: 1.36, color: kWizardTextDim),
        ),
      ],
    );
  }

  Widget _permGranted() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: const BoxDecoration(
                    color: Color(0x291F8039),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.check, size: 28, color: kWizardGreen),
                ),
                const SizedBox(height: 18),
                const Text(
                  'All set',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 8),
                const SizedBox(
                  width: 240,
                  child: Text(
                    'Screen Recording is on. Sinain can now see your screen and '
                    'hear system audio to help in context.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 13, height: 1.38, color: kWizardTextMuted),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (_error != null) ...[
          Text(
            _error!,
            style: const TextStyle(fontSize: 11, color: Color(0xFFFF6B6B)),
          ),
          const SizedBox(height: 8),
        ],
        WizardButton(label: 'Continue', onTap: _finish),
      ],
    );
  }

  // ── Step 5 · Finishing ───────────────────────────────────────────────────────

  Widget _finishing() {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 38,
            height: 38,
            child: CircularProgressIndicator(strokeWidth: 3, color: kWizardGreen),
          ),
          SizedBox(height: 20),
          SizedBox(
            width: 230,
            child: Text(
              'Writing config and starting the backend…',
              textAlign: TextAlign.center,
              style:
                  TextStyle(fontSize: 14, height: 1.43, color: kWizardTextMuted),
            ),
          ),
        ],
      ),
    );
  }
}
