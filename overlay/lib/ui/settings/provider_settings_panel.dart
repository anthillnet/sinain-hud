import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/services/provider_stack_service.dart';

/// Settings panel: explicit switch between the Cerebras / OpenRouter / Local
/// provider stacks, plus a "download local models" action so a cloud-tier
/// install can enable the local stack later without touching a terminal.
///
/// Chrome mirrors AgentSelectorPanel (Overlay UX Drafts · section F).
class ProviderSettingsPanel extends StatefulWidget {
  final VoidCallback onClose;

  const ProviderSettingsPanel({super.key, required this.onClose});

  @override
  State<ProviderSettingsPanel> createState() => _ProviderSettingsPanelState();
}

class _ProviderSettingsPanelState extends State<ProviderSettingsPanel> {
  static const _panelBg = Color(0xFF1E1F22);
  static const _selectBg = Color(0xFF2B2D30);
  static const _muted = Color(0xFFA8ADBD);
  static const _dim = Color(0xFF6C707E);
  static const _green = Color(0xFF1F8039);
  static const _stroke = Color(0x24FFFFFF);

  static const _backendChannel = MethodChannel('sinain_hud/backend');

  final _service = ProviderStackService();
  final _openRouterKeyCtl = TextEditingController();
  final _cerebrasKeyCtl = TextEditingController();
  ProviderStack? _pending; // selection not yet applied
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _service.addListener(_onService);
    _service.refresh();
    // Provisioning progress updates land in status files — poll while open.
    // Also keep polling while the backend is unreachable (e.g. it's restarting)
    // so the panel recovers on its own instead of pinning a stale error.
    _poll = Timer.periodic(const Duration(seconds: 3), (_) {
      if (_service.status?.provisioningActive == true ||
          _service.status == null ||
          _service.lastError != null) {
        _service.refresh();
      }
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _service.removeListener(_onService);
    _service.dispose();
    _openRouterKeyCtl.dispose();
    _cerebrasKeyCtl.dispose();
    super.dispose();
  }

  void _onService() {
    if (mounted) setState(() {});
  }

  ProviderStack? get _selected => _pending ?? _service.status?.activeStack;

  bool get _hasNewKeyForSelection {
    final s = _service.status;
    if (s == null) return false;
    switch (_selected) {
      case ProviderStack.openrouter:
        return !s.hasOpenRouterKey && _openRouterKeyCtl.text.trim().isNotEmpty;
      case ProviderStack.cerebras:
        return !s.hasCerebrasKey && _cerebrasKeyCtl.text.trim().isNotEmpty;
      default:
        return false;
    }
  }

  bool get _keyMissingForSelection {
    final s = _service.status;
    if (s == null) return false;
    switch (_selected) {
      case ProviderStack.openrouter:
        return !s.hasOpenRouterKey && _openRouterKeyCtl.text.trim().isEmpty;
      case ProviderStack.cerebras:
        return !s.hasCerebrasKey && _cerebrasKeyCtl.text.trim().isEmpty;
      default:
        return false;
    }
  }

  Future<void> _apply() async {
    final stack = _pending ?? _selected;
    if (stack == null) return;
    final ok = await _service.switchStack(
      stack,
      openRouterKey: _openRouterKeyCtl.text,
      cerebrasKey: _cerebrasKeyCtl.text,
      restartBackend: () async {
        try {
          await _backendChannel.invokeMethod('restart');
        } on PlatformException {
          // Dev stack (no bundled backend): user restarts manually.
        }
      },
    );
    if (ok && mounted) {
      setState(() => _pending = null);
      // The backend restart we just triggered takes several seconds — poll
      // until it's back instead of flashing "unreachable" from one attempt.
      unawaited(_service.refreshUntilReady());
    }
  }

  TextStyle _mono(double opacity, double size, {FontWeight? weight}) =>
      TextStyle(
        fontFamily: 'JetBrainsMono',
        fontSize: size,
        color: Colors.white.withValues(alpha: opacity),
        fontWeight: weight,
      );

  Widget _stackCard({
    required ProviderStack stack,
    required String title,
    required String subtitle,
    String? warning,
  }) {
    final active = _service.status?.activeStack == stack;
    final selected = _selected == stack;
    return GestureDetector(
      onTap: () => setState(
          () => _pending = stack == _service.status?.activeStack ? null : stack),
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: _selectBg,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: selected ? _green : _stroke),
        ),
        child: Row(
          children: [
            Icon(
              selected ? Icons.radio_button_checked : Icons.radio_button_off,
              size: 14,
              color: selected ? const Color(0xFF4CAF50) : _dim,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Text(title, style: _mono(0.9, 11, weight: FontWeight.w600)),
                    if (active) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 4, vertical: 1),
                        decoration: BoxDecoration(
                          color: _green.withValues(alpha: 0.25),
                          borderRadius: BorderRadius.circular(3),
                        ),
                        child: const Text('ACTIVE',
                            style: TextStyle(
                                fontSize: 8,
                                color: Color(0xFF4CAF50),
                                fontWeight: FontWeight.w700)),
                      ),
                    ],
                  ]),
                  const SizedBox(height: 2),
                  Text(subtitle, style: _mono(0.45, 9)),
                  if (warning != null) ...[
                    const SizedBox(height: 2),
                    Text(warning,
                        style: const TextStyle(
                            fontSize: 9, color: Color(0xFFFFAB00))),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _keyField(TextEditingController ctl, String hint) => Container(
        margin: const EdgeInsets.only(bottom: 6),
        height: 26,
        child: TextField(
          controller: ctl,
          obscureText: true,
          style: _mono(0.9, 10),
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            isDense: true,
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            hintText: hint,
            hintStyle: _mono(0.3, 10),
            filled: true,
            fillColor: _selectBg,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(4),
              borderSide: const BorderSide(color: _stroke),
            ),
          ),
        ),
      );

  Widget _localReadiness(ProviderStatus s) {
    Widget row(String label, bool ready) => Row(children: [
          Icon(ready ? Icons.check_circle : Icons.circle_outlined,
              size: 11,
              color: ready ? const Color(0xFF4CAF50) : _dim),
          const SizedBox(width: 5),
          Text(label, style: _mono(0.55, 9)),
        ]);
    final prov = s.provisioning.values.where((v) => v.isNotEmpty).join(' · ');
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          row('Ollama ${s.ollamaInstalled ? (s.ollamaUp ? "running" : "installed") : "not installed"}',
              s.ollamaUp),
          const SizedBox(height: 2),
          row('${s.llmReady && s.visionReady ? "" : "model "}qwen2.5vl:7b',
              s.llmReady && s.visionReady),
          const SizedBox(height: 2),
          row('whisper (local transcription)', s.whisperReady),
          if (!s.ollamaInstalled)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text('Install Ollama from ollama.com, then retry.',
                  style: TextStyle(fontSize: 9, color: Color(0xFFFFAB00))),
            ),
          if (s.provisioningActive && prov.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(prov, style: _mono(0.4, 9)),
            ),
          if (s.ollamaInstalled && !s.localReady && !s.provisioningActive)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: _button(
                'DOWNLOAD MODELS (~8 GB)',
                onTap: () => _service.startProvisioning(),
              ),
            ),
        ],
      ),
    );
  }

  Widget _button(String label, {VoidCallback? onTap, bool primary = false}) =>
      GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: onTap == null
                ? _selectBg
                : primary
                    ? _green
                    : _selectBg,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: onTap == null ? _stroke : _green),
          ),
          child: Text(label,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 9,
                fontWeight: FontWeight.w700,
                color: onTap == null
                    ? _dim
                    : primary
                        ? Colors.white
                        : const Color(0xFF4CAF50),
              )),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = _service.status;
    return Container(
      width: 300,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _panelBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: _stroke),
        boxShadow: const [
          BoxShadow(color: Color(0x66000000), blurRadius: 18, offset: Offset(0, 6)),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('AI PROVIDER',
                  style: _mono(0.5, 9, weight: FontWeight.w700)),
              const Spacer(),
              GestureDetector(
                onTap: widget.onClose,
                child: const Icon(Icons.close, size: 14, color: _muted),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (s == null)
            Text(_service.lastError ?? 'Loading…', style: _mono(0.4, 10))
          else ...[
            _stackCard(
              stack: ProviderStack.cerebras,
              title: 'Cerebras',
              subtitle: 'Fastest cloud briefs · screen context leaves this Mac',
              warning: _selected == ProviderStack.cerebras &&
                      !s.hasCerebrasKey &&
                      _cerebrasKeyCtl.text.trim().isEmpty
                  ? 'API key required'
                  : null,
            ),
            if (_selected == ProviderStack.cerebras && !s.hasCerebrasKey)
              _keyField(_cerebrasKeyCtl, 'CEREBRAS_API_KEY'),
            _stackCard(
              stack: ProviderStack.openrouter,
              title: 'OpenRouter',
              subtitle: 'Model marketplace · screen context leaves this Mac',
              warning: _selected == ProviderStack.openrouter &&
                      !s.hasOpenRouterKey &&
                      _openRouterKeyCtl.text.trim().isEmpty
                  ? 'API key required'
                  : null,
            ),
            if (_selected == ProviderStack.openrouter && !s.hasOpenRouterKey)
              _keyField(_openRouterKeyCtl, 'OPENROUTER_API_KEY'),
            _stackCard(
              stack: ProviderStack.local,
              title: 'Local',
              subtitle: 'qwen2.5vl on this Mac · nothing leaves the device',
              warning: _selected == ProviderStack.local && !s.localReady
                  ? 'models not downloaded yet'
                  : null,
            ),
            if (_selected == ProviderStack.local) _localReadiness(s),
            const SizedBox(height: 4),
            Row(
              children: [
                if (_service.lastError != null)
                  Expanded(
                    child: Text(_service.lastError!,
                        style: const TextStyle(
                            fontSize: 9, color: Color(0xFFFF6B6B)),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis),
                  )
                else
                  const Spacer(),
                _button(
                  _service.switching ? 'SWITCHING…' : 'APPLY & RESTART',
                  primary: true,
                  onTap: (_pending == null && !_hasNewKeyForSelection) ||
                          _service.switching ||
                          _keyMissingForSelection ||
                          (_selected == ProviderStack.local &&
                              !(s.localReady))
                      ? null
                      : _apply,
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
