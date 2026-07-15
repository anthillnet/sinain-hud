import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// Provider stacks the user can switch between from Settings.
enum ProviderStack { cerebras, openrouter, local }

/// Readiness + progress snapshot from GET /setup/providers.
class ProviderStatus {
  const ProviderStatus({
    required this.activeStack,
    required this.hasOpenRouterKey,
    required this.hasCerebrasKey,
    required this.ollamaInstalled,
    required this.ollamaUp,
    required this.llmReady,
    required this.visionReady,
    required this.whisperReady,
    required this.provisioning,
  });

  final ProviderStack activeStack;
  final bool hasOpenRouterKey;
  final bool hasCerebrasKey;
  final bool ollamaInstalled;
  final bool ollamaUp;
  final bool llmReady;
  final bool visionReady;
  final bool whisperReady;

  /// Raw `state|percent|message` lines from ~/.sinain/provisioning/*.status,
  /// keyed by component ("ollama", "whisper").
  final Map<String, String> provisioning;

  bool get localReady => llmReady && visionReady && whisperReady;

  bool get provisioningActive => provisioning.values
      .any((s) => s.startsWith('pulling') || s.startsWith('downloading'));

  static ProviderStatus fromJson(Map<String, dynamic> j) {
    final local = (j['local'] as Map<String, dynamic>?) ?? const {};
    final keys = (j['keys'] as Map<String, dynamic>?) ?? const {};
    return ProviderStatus(
      activeStack: ProviderStack.values.firstWhere(
        (s) => s.name == j['activeStack'],
        orElse: () => ProviderStack.openrouter,
      ),
      hasOpenRouterKey: keys['openrouter'] == true,
      hasCerebrasKey: keys['cerebras'] == true,
      ollamaInstalled: local['ollamaInstalled'] == true,
      ollamaUp: local['ollamaUp'] == true,
      llmReady: local['llmReady'] == true,
      visionReady: local['visionReady'] == true,
      whisperReady: local['whisperReady'] == true,
      provisioning: ((j['provisioning'] as Map<String, dynamic>?) ?? const {})
          .map((k, v) => MapEntry(k, v.toString())),
    );
  }
}

/// Reads provider readiness from sinain-core and switches the active stack by
/// rewriting `~/.sinain/.env` (same file the first-run wizard writes) and
/// restarting the backend. Existing env lines are PRESERVED — switching stacks
/// only touches the keys each stack owns, so API keys survive round-trips.
class ProviderStackService extends ChangeNotifier {
  ProviderStackService({this.coreUrl = 'http://localhost:9500'});

  final String coreUrl;

  ProviderStatus? status;
  bool switching = false;
  String? lastError;

  String get _envPath {
    final home = Platform.environment['HOME'] ?? '';
    return '$home/.sinain/.env';
  }

  Future<void> refresh() async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
      final req = await client.getUrl(Uri.parse('$coreUrl/setup/providers'));
      final resp = await req.close();
      final body = await resp.transform(utf8.decoder).join();
      client.close();
      status = ProviderStatus.fromJson(jsonDecode(body) as Map<String, dynamic>);
      lastError = null;
    } catch (e) {
      lastError = 'core unreachable: $e';
    }
    notifyListeners();
  }

  /// Kick off background model downloads (Ollama models + whisper).
  Future<bool> startProvisioning() async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
      final req = await client.postUrl(Uri.parse('$coreUrl/setup/provision'));
      final resp = await req.close();
      final body = await resp.transform(utf8.decoder).join();
      client.close();
      final ok = (jsonDecode(body) as Map<String, dynamic>)['ok'] == true;
      if (!ok) lastError = body;
      notifyListeners();
      return ok;
    } catch (e) {
      lastError = 'provisioning failed to start: $e';
      notifyListeners();
      return false;
    }
  }

  /// Env keys a stack switch is allowed to touch. Everything else in the
  /// user's env file (privacy mode, custom pins, keys) is left alone.
  static const _managedKeys = <String>{
    'SINAIN_LOCAL_MODE',
    'SINAIN_LOCAL_LLM',
    'SINAIN_LOCAL_VISION',
    'ANALYSIS_PROVIDER',
    'ANALYSIS_ENDPOINT',
    'ANALYSIS_MODEL',
    'ANALYSIS_VISION_MODEL',
    'BURST_PROVIDER',
    'BURST_ENDPOINT',
    'BURST_MODEL',
    'TRANSCRIPTION_BACKEND',
  };

  Map<String, String> _stackEnv(ProviderStack stack, {required bool whisperReady}) {
    switch (stack) {
      case ProviderStack.local:
        // qwen2.5vl:7b serves BOTH text and vision lanes (2026-07-15 bench:
        // best local distill quality, 1s vision ticks, one 7.3GB residency).
        return {
          'SINAIN_LOCAL_MODE': 'true',
          'SINAIN_LOCAL_LLM': 'qwen2.5vl:7b',
          'SINAIN_LOCAL_VISION': 'qwen2.5vl:7b',
          'TRANSCRIPTION_BACKEND': 'local',
        };
      case ProviderStack.cerebras:
        return {
          'SINAIN_LOCAL_MODE': 'false',
          'ANALYSIS_PROVIDER': 'openrouter', // OpenAI-compat transport
          'ANALYSIS_ENDPOINT': 'https://api.cerebras.ai/v1/chat/completions',
          'ANALYSIS_MODEL': 'gemma-4-31b',
          'BURST_PROVIDER': 'cerebras',
          'BURST_ENDPOINT': 'https://api.cerebras.ai/v1/chat/completions',
          'BURST_MODEL': 'gemma-4-31b',
          'TRANSCRIPTION_BACKEND': whisperReady ? 'local' : 'openrouter',
        };
      case ProviderStack.openrouter:
        return {
          'SINAIN_LOCAL_MODE': 'false',
          'ANALYSIS_PROVIDER': 'openrouter',
          'ANALYSIS_ENDPOINT': 'https://openrouter.ai/api/v1/chat/completions',
          'ANALYSIS_MODEL': 'google/gemini-2.5-flash-lite',
          'ANALYSIS_VISION_MODEL': 'google/gemini-2.5-flash',
          'BURST_PROVIDER': 'openrouter',
          'BURST_ENDPOINT': 'https://openrouter.ai/api/v1/chat/completions',
          'BURST_MODEL': 'google/gemini-2.5-flash-lite',
          'TRANSCRIPTION_BACKEND': whisperReady ? 'local' : 'openrouter',
        };
    }
  }

  /// Rewrite ~/.sinain/.env for [stack], preserving unmanaged lines, then
  /// restart the backend via [restartBackend] (injected — lives on
  /// FirstRunService's platform channel).
  Future<bool> switchStack(
    ProviderStack stack, {
    String? openRouterKey,
    String? cerebrasKey,
    required Future<void> Function() restartBackend,
  }) async {
    switching = true;
    lastError = null;
    notifyListeners();
    try {
      final file = File(_envPath);
      final existing = <String>[];
      if (await file.exists()) existing.addAll(await file.readAsLines());

      final overrides = _stackEnv(stack,
          whisperReady: status?.whisperReady ?? false);
      if ((openRouterKey ?? '').trim().isNotEmpty) {
        overrides['OPENROUTER_API_KEY'] = openRouterKey!.trim();
      }
      if ((cerebrasKey ?? '').trim().isNotEmpty) {
        overrides['CEREBRAS_API_KEY'] = cerebrasKey!.trim();
      }

      final out = <String>[];
      final written = <String>{};
      for (final line in existing) {
        final m = RegExp(r'^([A-Z0-9_]+)=').firstMatch(line.trim());
        final key = m?.group(1);
        if (key != null && overrides.containsKey(key)) {
          out.add('$key=${overrides[key]}');
          written.add(key);
        } else if (key != null &&
            _managedKeys.contains(key) &&
            !overrides.containsKey(key)) {
          // A managed key the new stack doesn't set — drop the stale pin.
        } else {
          out.add(line);
        }
      }
      for (final e in overrides.entries) {
        if (!written.contains(e.key)) out.add('${e.key}=${e.value}');
      }
      await file.parent.create(recursive: true);
      await file.writeAsString('${out.join('\n')}\n');
      debugPrint('[provider-stack] wrote $_envPath for ${stack.name}');
      await restartBackend();
      return true;
    } catch (e) {
      lastError = 'switch failed: $e';
      return false;
    } finally {
      switching = false;
      notifyListeners();
    }
  }
}
