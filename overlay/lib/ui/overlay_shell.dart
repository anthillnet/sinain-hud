import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/app_control.dart';
import '../core/constants.dart';
import '../core/models/hud_settings.dart';
import '../core/models/agent_session.dart';
import '../core/services/settings_service.dart';
import '../core/theme/hud_theme.dart';
import '../core/services/websocket_service.dart';
import '../core/services/window_service.dart';
import 'eye/eye_widget.dart';
import 'feed/idle_animation.dart';
import 'settings/display_settings_panel.dart';
import 'settings/agent_selector_panel.dart';
import 'settings/provider_settings_panel.dart';
import 'hud_tooltip.dart';
import 'chat/permission_banner.dart';
import 'chat/feedback_prompt.dart';
import 'regions/region_eye_controller.dart';
import 'chat/chat_thread_view.dart';
import 'terminal/thread_terminal_view.dart';
import '../core/models/context_cards.dart';
import '../core/models/feed_item.dart';
import '../core/models/region_highlight.dart';
import 'capture/capture_ui.dart';
import 'capture/session_list_view.dart';
import 'agents/agent_sessions_view.dart';
import 'agents/agent_approval_card.dart';
import 'agents/agent_island_bar.dart';

enum _IslandView { bar, stack, approval }

/// Top-level shell managing the 3-state overlay: Eye → Controls → Chat.
class OverlayShell extends StatefulWidget {
  const OverlayShell({super.key});

  @override
  OverlayShellState createState() => OverlayShellState();
}

class OverlayShellState extends State<OverlayShell> {
  static final bool _isMacOS = Platform.isMacOS;
  static const double _islandBarWidth = 208;
  // The bar grows when the amber "· N waiting" segment is present.
  static const double _islandBarWaitingWidth = 284;
  double _islandBarWidthFor(WebSocketService ws) {
    final liveAssist = ws.voiceSession?.isActive ?? false;
    final hasEnrich = _islandEnrichLabel != null;
    final hasSave = _saveOffer != null;
    final tracked = _warmChip;
    if (_notchHeight > 0) {
      final rightWing = liveAssist
          ? 210.0
          : ws.agentWaiting > 0
              ? 236.0
              : hasEnrich
                  ? 286.0
                  : hasSave || tracked != null
                      ? 210.0
                      : ws.agentWorking > 0
                          ? 132.0
                          : 0.0;
      return 46 + _notchWidth + rightWing;
    }
    if (liveAssist) return 250;
    if (ws.agentWaiting > 0) return _islandBarWaitingWidth;
    if (hasEnrich) return 330;
    if (hasSave || tracked != null) return 250;
    // Pinned with no agents: eye-only pill.
    if (ws.agentWorking == 0) return 46;
    return _islandBarWidth;
  }

  double _islandFrameWidthFor(WebSocketService ws, _IslandView view) {
    final barWidth = _islandBarWidthFor(ws);
    if (view == _IslandView.bar) {
      if (_notchHeight > 0 || barWidth >= 300) return barWidth;
      return 300;
    }
    if (_notchHeight == 0) return 320;
    return barWidth >= 320 ? barWidth : 320;
  }

  double get _notchHeight => _islandNotchInfo?['notchHeight'] ?? 0;
  double get _notchWidth {
    final screen = _islandScreenFrame;
    final notch = _islandNotchInfo;
    if (screen == null || notch == null || _notchHeight <= 0) return 0;
    return screen['w']! - notch['leftAuxWidth']! - notch['rightAuxWidth']!;
  }

  double get _menuBarHeight {
    final screen = _islandScreenFrame;
    if (screen == null) return 24;
    final height =
        (screen['y']! + screen['h']!) - (screen['vy']! + screen['vh']!);
    return height > 0 ? height : 24;
  }

  late HudState _state;
  late HudState _lastVisibleState;

  late final WindowService _windowService;
  late final SettingsService _settingsService;

  // Contextual eye animation state
  bool _isThinking = false;
  bool _hasNewContent = false;
  Timer? _contentResetTimer;
  StreamSubscription<bool>? _thinkingSub;
  StreamSubscription? _forkSub;
  bool _awaitingFork = false;
  StreamSubscription? _manualRegionSub;
  bool _awaitingManualRegion = false;
  // Manual ROI ids present BEFORE the current drag-select, so the broadcast
  // handler can pick the NEWLY-created region instead of re-grabbing an earlier
  // one (which would keep the user stuck on the first ROI's thread).
  Set<String> _manualIdsBefore = {};
  // Destination chosen in the drag-select toolbar ('chat' | 'term') — applied
  // when the freshly-created manual ROI arrives back over regionStream.
  String _pendingManualMode = 'chat';
  // Top-left-origin screen point to teleport the HUD to for a manual ROI (the
  // selection's bottom-left, so the chat opens just below the grabbed region).
  Offset? _pendingManualPos;
  StreamSubscription<FeedItem>? _contentSub;

  // Pending-permission signal — drives orange eye color and pupil dilation.
  // Hidden state intentionally ignores this: explicit user hide outranks
  // agent's "I need attention". Agent will time out into deny.
  // NOTE: no auto-switch to Tasks tab — permissions are handled via the
  // PermissionBanner above the chat input only.
  int _pendingAttention = 0;
  WebSocketService? _wsForListener;
  VoidCallback? _wsListener;
  bool _wsWasConnected = false;

  bool _parked = false;
  bool _unparkedByUser = false;
  // Set by drag-to-park: the island stays parked even with no agent sessions.
  bool _pinnedByUser = false;
  bool _windowOpInFlight = false;
  Map<String, double>? _preParkFrame;
  Map<String, double>? _islandScreenFrame;
  Map<String, double>? _islandNotchInfo;
  _IslandView _islandView = _IslandView.bar;
  bool _islandHoverExpanded = false;
  bool _islandPinned = false;
  Timer? _islandCollapseTimer;
  double _islandDragDistance = 0;
  final Set<String> _dismissedApprovals = {};
  AgentApprovalRequest? _resolvedApproval;
  String? _approvalResolution;
  Timer? _resolutionTimer;

  // Display settings panel
  bool _showDisplaySettings = false;
  bool _showAgentPicker = false;
  bool _showProviderSettings = false;

  // One-time "Was that helpful?" feedback prompt. Armed once per app run at the
  // first value-proof moment (first agent reply); lifecycle persisted in
  // SettingsService. _feedbackEvaluated guards against re-arming every reply.
  bool _feedbackVisible = false;
  bool _feedbackEvaluated = false;

  // Deliberate capture (Save · Call AI · Build context)
  String? _chooserFor; // null | 'save' | 'call'
  // Compact card mode: cards shown in a slim panel without opening the chat.
  bool _cardMode = false;
  // Full clipboard text behind the current enrich card (focus is a preview).
  String? _enrichFocusFull;
  // Region + minutes: a summon brief bound to the next manual region. The
  // brief renders no card — it attaches to the region thread as handoff
  // context. Pending flag → brief text (once ready) → target thread id.
  bool _regionBriefPending = false;
  String? _pendingRegionBrief;
  String? _regionBriefTarget;
  // Region selected via the capture menu: unified select→enrich→handoff UX.
  // The region becomes the enrich card's focus; handoff opens its thread.
  bool _regionViaMenu = false;
  RegionHighlight? _pendingRegion;
  // Where a summon follow-up goes: 'chat' (agent lane) | 'term' (seeded PTY).
  String _summonDest = 'chat';
  List<RangeOption> _rangeOptions = const [];
  ContextBrief? _activeBrief;
  EnrichCard? _activeEnrich;
  String? _islandEnrichLabel;
  Timer? _enrichChipTimer;
  SaveReceipt? _saveReceipt;
  StreamSubscription<ContextBrief>? _briefSub;
  StreamSubscription<EnrichCard>? _enrichSub;
  StreamSubscription<SaveReceipt>? _receiptSub;
  StreamSubscription<VoiceSession>? _voiceSub;
  VoiceSession? _voiceSession;
  // Breakpoint save offer (DESIGN-SAVE-OFFER.md, arrival A): the card just
  // appears — evidence and actions visible at once — and morphs into the
  // receipt on accept. Untouched, it fades silently after ~45 s.
  SaveOffer? _saveOffer;
  Timer? _offerExpiryTimer;
  StreamSubscription<SaveOffer>? _offerSub;
  // Adjust…: the offer whose pre-filled chooser is open — confirm posts
  // "adjusted" (a correction label) instead of a plain save.
  String? _adjustingOfferId;
  List<String>? _offerPrefillApps;
  int? _offerPrefillMinutes;
  // Session Sense (DESIGN-SESSION-SENSE.md, ladder rung 2): the live workflow
  // nudge, the running-session chip, and the symmetric wrap prompt.
  SessionNudge? _sessionNudge;
  Timer? _nudgeExpiryTimer;
  // Parallel sessions (§5): one warm, the rest paused. The chip shows the
  // warm one (with a "+N" affix when others exist); the SESSIONS view and
  // detail card cover the stack.
  final Map<String, SessionChipState> _sessionChips = {};
  SessionWrap? _sessionWrap;
  // Help-forward: composed per session; the detail card reveals it.
  final Map<String, SessionAssist> _sessionAssists = {};
  bool _assistVisible = false;
  // The bookmarked-sessions shelf (§9), opened from the eye menu.
  List<SessionBookmark>? _sessionShelf;
  // The sessions list is the HUD's primary uncollapsed view (product call
  // 2026-07-16): SESSIONS tab, selected by default on every uncollapse.
  bool _sessionsTab = true;
  // Session-verb summons skip the brief preview and hand off on arrival.
  bool _autoHandoffBrief = false;
  StreamSubscription<SessionNudge>? _nudgeSub;
  StreamSubscription<SessionChipState>? _chipSub;
  StreamSubscription<SessionWrap>? _wrapSub;
  StreamSubscription<SessionAssist>? _assistSub;

  // Command input focus
  final _commandFocusNode = FocusNode();

  // Grammarly mode: native region eyes (macOS only)
  RegionEyeController? _regionEyes;
  // Region whose action banner is showing in the chat (set on eye tap).
  // While set, the chat input routes to that region's agent thread.
  RegionHighlight? _activeRegion;
  // Selected chat tab: null = MAIN feed, otherwise a region thread id.
  // Each ROI is its own conversation; the input routes to the active tab.
  String? _activeThread;
  // SPIKE: tabs currently showing a terminal instead of the chat feed.
  final Set<String> _terminalThreads = {};
  // Refreshes core's ambient-escalation quiet window while a terminal is up.
  Timer? _busyTimer;
  // Regions whose thread already started (Run pressed / follow-up sent)
  final Set<String> _startedRegionThreads = {};

  @override
  void initState() {
    super.initState();
    _windowService = context.read<WindowService>();
    _settingsService = context.read<SettingsService>();

    // Restore persisted state (defaults to chat for new installs)
    _state = _settingsService.settings.overlayState;
    _lastVisibleState = _state == HudState.hidden ? HudState.chat : _state;

    // Ensure window size matches restored state (may differ from native default)
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _resizeWindowForState(_state);
      if (!mounted) return;
      if (_state == HudState.eye && _settingsService.settings.notchParked) {
        _pinnedByUser = true;
        _unparkedByUser = false;
        await _parkIsland();
      }
      if (_state == HudState.chat) _windowService.makeKeyWindow();
    });

    // While a thread terminal is visible the user is conversing with an
    // agent — keep refreshing the ambient-escalation quiet window (core
    // holds it ~3 min per ping; chat messages refresh it server-side).
    _busyTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_terminalThreads.contains(_activeTabKey) &&
          _state != HudState.hidden) {
        context.read<WebSocketService>().sendUserBusy();
      }
    });

    // Native drag/resize callbacks (macOS only)
    if (_isMacOS) {
      _windowService.setupNativeCallbacks(
        // Eye drags may end in the notch zone → park as the island; the
        // zone check + persist both live in _onEyeDragEnd. Other window
        // drags (chat, wizard) keep the plain position persist.
        onDragDone: (x, y) {
          if (_state == HudState.eye && !_parked) {
            _onEyeDragEnd();
          } else {
            _settingsService.setEyePosition(x, y);
          }
        },
        onResizeDone: (w, h) => _settingsService.setChatSize(w, h),
      );
    }

    final ws = context.read<WebSocketService>();
    // After tapping ⑂ the new fork tab arrives as a thread-status update —
    // switch to it so the user lands in the thread they just created.
    _forkSub = ws.spawnTaskStream.listen((task) {
      if (!mounted || !_awaitingFork) return;
      final id = task.regionId;
      if (id != null && id.startsWith('fork-')) {
        _awaitingFork = false;
        _selectThread(id);
      }
    });
    // After a drag-select the manual region arrives in the next
    // region_highlight — open its thread immediately: selecting a region
    // IS the declaration of intent to talk about it.
    _manualRegionSub = ws.regionStream.listen((regions) {
      if (!mounted || !_awaitingManualRegion) return;
      // Pick the region that's NEW since the drag-select started — the
      // broadcast still includes earlier manual ROIs, and grabbing the first
      // r-man-* would re-select an old one (reusing its thread). Fall back to
      // the newest-by-id (base36 timestamp) if the snapshot missed it.
      RegionHighlight? fresh;
      for (final r in regions) {
        if (!r.id.startsWith('r-man-') || _manualIdsBefore.contains(r.id)) {
          continue;
        }
        if (fresh == null || r.id.compareTo(fresh.id) > 0) fresh = r;
      }
      if (fresh == null) return; // new region not in this batch yet — wait
      final picked =
          fresh; // final → survives promotion into the setState closure
      _awaitingManualRegion = false;
      // Register its tab (eye-tap path does this; manual path must too) so the
      // ROI gets a distinct, switchable tab instead of silently replacing.
      ws.registerRegionThread(picked.id, picked.issue);
      // Region + minutes (context-menu flow): attach the window brief to this
      // thread BEFORE the first agent turn — commands are ordered on the same
      // socket, so a stash sent now lands before run()'s spawn seed is built.
      // If the brief is still in flight, stash on arrival (follow-ups get it).
      if (_pendingRegionBrief != null) {
        ws.sendCommand('set_handoff_context',
            {'key': picked.id, 'transcript': _pendingRegionBrief!});
        _pendingRegionBrief = null;
        _regionBriefPending = false;
      } else if (_regionBriefPending) {
        _regionBriefTarget = picked.id;
      }
      // Menu flow (select→enrich→handoff): the region is the enrich card's
      // focus — same card experience as Build Context / Call AI. No auto-run;
      // the card's handoff button opens the region thread deliberately.
      if (_regionViaMenu) {
        _regionViaMenu = false;
        _pendingRegion = picked;
        final focus = picked.issue.isNotEmpty
            ? picked.issue
            : 'the selected screen region';
        _enrichFocusFull = focus;
        _enterCardMode();
        ws.requestEnrich(focus);
        return;
      }
      // "Copy" — just put this region's composed seed on the clipboard (for an
      // agent we don't integrate with). No thread, no HUD, no agent turn.
      if (_pendingManualMode == 'copy') {
        _copySeed(key: picked.id);
        return;
      }
      // A chat on a desktop lane (Claude Desktop / ChatGPT) opens the external
      // app, not the in-HUD chat — so route it through run() (which seeds the
      // ROI + launches the app via core) and leave the HUD collapsed.
      final desktopChat = _pendingManualMode == 'chat' && ws.escalationDesktop;
      if (_pendingManualMode == 'term') {
        _openTerminalForTab(picked.id); // marks started + opens the PTY
      } else {
        setState(() => _startedRegionThreads.add(picked.id));
        // Start the agent turn on the selected ROI so the user gets an initial
        // response about what they selected — selecting a region IS the intent
        // to talk about it. Mirrors the auto-ROI card's Chat action (which
        // always calls run()). For a desktop lane run() launches the external
        // app; for the in-HUD native chat it fires the spawn command (→ an
        // agent reply scoped to this thread) and we also open the thread.
        _regionEyes?.run(picked);
        if (!desktopChat) {
          _selectThread(picked.id);
        }
      }
      // Teleport the HUD to the grabbed region and uncollapse it — matches the
      // auto-ROI path. Skipped for a desktop chat (its surface is the app).
      if (!desktopChat) {
        final p = _pendingManualPos;
        if (p != null) {
          _openChatNearRegion(p.dx, p.dy, 0);
        } else {
          _transitionTo(HudState.chat);
        }
      }
    });
    _thinkingSub = ws.thinkingStream.listen((active) {
      if (mounted) setState(() => _isThinking = active);
    });
    // Deliberate-capture cards (context_brief / enrich_card / save_receipt).
    // Outside the chat they surface in compact card mode — no full HUD.
    _briefSub = ws.briefStream.listen((b) {
      if (!mounted) return;
      // Region-bound brief: no card — it becomes the region thread's handoff
      // context (stashed here if the region already exists, else on arrival).
      if (_regionBriefPending) {
        if (b.status == CardStatus.ready) {
          final text = _briefText(b);
          if (_regionBriefTarget != null) {
            ws.sendCommand('set_handoff_context',
                {'key': _regionBriefTarget!, 'transcript': text});
            _regionBriefTarget = null;
            _regionBriefPending = false;
          } else {
            _pendingRegionBrief = text;
          }
        } else if (b.status == CardStatus.error) {
          _regionBriefPending = false; // plain region grab, no window context
        }
        return;
      }
      // Call-AI-immediately (product call 2026-07-16): a summon fired from a
      // session verb skips the brief preview — the ready brief hands off to
      // the chosen lane directly. Errors still surface as the normal card.
      if (_autoHandoffBrief) {
        if (b.status == CardStatus.working) return; // silent — no card flash
        _autoHandoffBrief = false;
        if (b.status == CardStatus.ready) {
          _askFollowUpOnBrief(b);
          return;
        }
      }
      setState(() => _activeBrief = b);
      _enterCardMode();
    });
    _enrichSub = ws.enrichStream.listen((c) {
      if (!mounted) return;
      _enrichChipTimer?.cancel();
      setState(() {
        _activeEnrich = c;
        if (_parked && c.status != CardStatus.error) {
          _islandEnrichLabel = _warmChip?.label ?? 'session';
        }
      });
      if (_parked) _scheduleIslandResize();
      if (_parked) {
        if (c.status == CardStatus.ready) {
          _enrichChipTimer = Timer(const Duration(seconds: 6), () {
            if (mounted && _activeEnrich?.requestId == c.requestId) {
              setState(() => _islandEnrichLabel = null);
              _scheduleIslandResize();
            }
          });
        } else if (c.status == CardStatus.error) {
          setState(() => _islandEnrichLabel = null);
          _scheduleIslandResize();
        }
      } else {
        _enterCardMode();
      }
    });
    _receiptSub = ws.saveReceiptStream.listen((r) {
      if (!mounted) return;
      // "undone" confirms the user's own action — no card resurrection needed.
      if (r.status == SaveStatus.undone && _saveReceipt == null) return;
      setState(() => _saveReceipt = r);
      _enterCardMode();
      if (r.status == SaveStatus.committed || r.status == SaveStatus.undone) {
        Timer(const Duration(seconds: 4), () {
          if (mounted && _saveReceipt?.saveId == r.saveId) {
            setState(() => _saveReceipt = null);
            _maybeExitCardMode();
          }
        });
      }
    });
    _offerSub = ws.saveOfferStream.listen((o) {
      if (!mounted) return;
      _showSaveOffer(o);
    });
    _nudgeSub = ws.sessionNudgeStream.listen((n) {
      if (!mounted) return;
      _showSessionNudge(n);
    });
    _chipSub = ws.sessionChipStream.listen((c) {
      if (!mounted) return;
      setState(() {
        if (c.ended) {
          _sessionChips.remove(c.sessionId);
          _sessionAssists.remove(c.sessionId);
          if (_sessionWrap?.sessionId == c.sessionId) _sessionWrap = null;
          if (_sessionChips.isEmpty) _assistVisible = false;
        } else {
          _sessionChips[c.sessionId] = c;
        }
      });
      if (c.ended) {
        _maybeExitCardMode();
      } else {
        _enterCardMode();
      }
    });
    _assistSub = ws.sessionAssistStream.listen((a) {
      if (!mounted) return;
      // Only ready assists surface; working/error stay silent — the detail
      // card simply shows the verbs without the details.
      if (a.ready) setState(() => _sessionAssists[a.sessionId] = a);
    });
    _wrapSub = ws.sessionWrapStream.listen((w) {
      if (!mounted) return;
      setState(() => _sessionWrap = w);
      _enterCardMode();
    });
    _voiceSub = ws.voiceSessionStream.listen((s) {
      if (!mounted) return;
      setState(() => _voiceSession = s);
      _enterCardMode();
      if (s.status == VoiceStatus.ended || s.status == VoiceStatus.error) {
        // Webview engine: core broadcast the end (End button, server hangup,
        // page error) — tear the hidden webview down so the mic releases.
        _windowService.closeCallEngine();
      }
      if (s.status == VoiceStatus.ended) {
        Timer(const Duration(seconds: 3), () {
          if (mounted && _voiceSession?.status == VoiceStatus.ended) {
            setState(() => _voiceSession = null);
            _maybeExitCardMode();
          }
        });
      }
    });
    _contentSub = ws.agentFeedStream.listen((_) {
      if (!mounted) return;
      setState(() => _hasNewContent = true);
      _contentResetTimer?.cancel();
      _contentResetTimer = Timer(const Duration(seconds: 5), () {
        if (mounted) setState(() => _hasNewContent = false);
      });
      // First agent reply = the first value-proof moment. Arm the one-time
      // feedback prompt here (once per run) if it's still eligible. An agent
      // reply only happens after setup, so this is inherently post-onboarding.
      _maybeArmFeedbackPrompt();
    });

    // Watch pending-permission count from WebSocketService (ChangeNotifier).
    // Only used to drive eye color + pupil dilation. No auto-switch to Tasks
    // tab — permissions are surfaced exclusively via PermissionBanner.
    _wsForListener = ws;
    _wsListener = () {
      if (!mounted) return;
      if (ws.connected && !_wsWasConnected) {
        ws.sendCommand('set_agent_llm_brief',
            {'enabled': _settingsService.settings.agentLlmBrief});
      }
      _wsWasConnected = ws.connected;
      final n = ws.pendingAttentionCount;
      if (n != _pendingAttention) setState(() => _pendingAttention = n);
      _syncIslandFromWs(ws);
    };
    ws.addListener(_wsListener!);
    if (ws.connected) {
      _wsWasConnected = true;
      ws.sendCommand('set_agent_llm_brief',
          {'enabled': _settingsService.settings.agentLlmBrief});
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncIslandFromWs(ws));

    // Region eyes (Grammarly mode) — native NSPanels, macOS only
    if (_isMacOS) {
      _regionEyes = RegionEyeController(
        windowService: _windowService,
        ws: ws,
        settingsService: _settingsService,
        onRegionTap: (region, pos, teleport) {
          // Single tap → toggle the lightweight preview (no chat needed to see
          // what the ROI is about). Tapping the same eye again closes it.
          if (!teleport) {
            setState(() {
              if (_activeRegion?.id == region.id) {
                _activeRegion = null; // toggle off
              } else {
                ws.registerRegionThread(region.id, region.issue);
                _activeRegion = region;
                _activeThread = region.id;
              }
            });
            return;
          }
          // Double tap → bring the HUD/chat to the region.
          ws.registerRegionThread(region.id, region.issue);
          setState(() {
            _activeRegion = region;
            _activeThread = region.id;
          });
          _openChatNearRegion(pos.dx, pos.dy, region.display);
        },
        // "Term" on the native ROI card → open the region as a terminal thread
        // and bring the HUD to it (mirrors the chat-teleport path).
        onRegionTerminal: (region, pos) {
          ws.registerRegionThread(region.id, region.issue);
          setState(() {
            _activeRegion = region;
            _activeThread = region.id;
          });
          _openTerminalForTab(region.id);
          _openChatNearRegion(pos.dx, pos.dy, region.display);
        },
        // "Copy" on the native ROI card → copy this region's composed seed,
        // then flash the green check on the card and auto-dismiss it.
        onRegionCopy: (region) => _copySeed(
          key: region.id,
          onDone: () => _windowService.confirmRegionCopy(region.id),
        ),
      )..start();
    }
  }

  static const _redEye = Color(0xFFFF3344);
  static const _pendingOrange = Color(0xFFFFAA00);

  double get _pupilDilation {
    if (_pendingAttention > 0) return 1.0; // blocked on user — full dilation
    if (_isThinking) return 0.3;
    if (_hasNewContent) return 0.6;
    return 0.0;
  }

  Color get _accentColor {
    final c = _settingsService.settings.accentColor;
    return Color(c != 0 ? c : 0xFF00FF88);
  }

  Color get _eyeColor {
    if (_pendingAttention > 0) return _pendingOrange;
    return _settingsService.settings.privacyMode ? _accentColor : _redEye;
  }

  double? _islandSnappedWidth;

  AgentApprovalRequest? _nextApproval(WebSocketService ws) {
    final approvals = ws.agentApprovals.values
        .where((request) => !_dismissedApprovals.contains(request.id))
        .toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return approvals.isEmpty ? null : approvals.first;
  }

  void _syncIslandFromWs(WebSocketService ws) {
    if (!mounted) return;
    final active = ws.agentWorking + ws.agentWaiting > 0;
    final completelyIdle = !active && ws.agentApprovals.isEmpty;
    _dismissedApprovals.removeWhere((id) => !ws.agentApprovals.containsKey(id));
    if (completelyIdle) {
      _unparkedByUser = false;
      // A drag-parked (pinned) island rides out idle as the eye-only pill.
      if (_parked && !_pinnedByUser) _unparkIsland();
      return;
    }
    if (!_parked && _state == HudState.eye && active && !_unparkedByUser) {
      _parkIsland();
      return;
    }
    final approval = _nextApproval(ws);
    if (_parked &&
        _islandView == _IslandView.bar &&
        approval != null &&
        _resolvedApproval == null) {
      _setIslandView(_IslandView.approval);
    } else if (_parked &&
        _islandView == _IslandView.approval &&
        approval == null &&
        _resolvedApproval == null) {
      _setIslandView(_IslandView.bar);
    }
    // Re-place whenever the content-dependent bar width changes.
    final islandWidth = _islandFrameWidthFor(ws, _islandView);
    if (_parked && islandWidth != _islandSnappedWidth) {
      _islandSnappedWidth = islandWidth;
      _snapIslandToNotch();
    }
  }

  Future<void> _parkIsland({Map<String, double>? homeFrame}) async {
    if (_parked || _windowOpInFlight || _state != HudState.eye) return;
    _windowOpInFlight = true;
    final frame = await _windowService.getWindowFrame();
    final screen = await _windowService.getScreenFrame();
    final notchInfo = _isMacOS ? await _windowService.getNotchInfo() : null;
    if (!mounted) {
      _windowOpInFlight = false;
      return;
    }
    if (frame == null ||
        screen == null ||
        _state != HudState.eye ||
        _unparkedByUser) {
      _windowOpInFlight = false;
      return;
    }
    // For a drag-park the current frame is the notch drop point — unparking
    // should return the eye to its persisted home instead.
    _preParkFrame = homeFrame ?? frame;
    _islandScreenFrame = screen;
    _islandNotchInfo = notchInfo;
    _islandSnappedWidth =
        _islandFrameWidthFor(context.read<WebSocketService>(), _IslandView.bar);
    setState(() {
      _parked = true;
      _islandView = _nextApproval(context.read<WebSocketService>()) == null
          ? _IslandView.bar
          : _IslandView.approval;
    });
    _settingsService.setNotchParked(true);
    if (_isMacOS) await _windowService.setNotchParked(true);
    await _placeIslandFrame();
    _windowOpInFlight = false;
  }

  Future<void> _placeIslandFrame() async {
    final screen = _islandScreenFrame;
    if (screen == null) return;
    final ws = context.read<WebSocketService>();
    final notchMode = _notchHeight > 0;
    final width = _islandFrameWidthFor(ws, _islandView);
    _islandSnappedWidth = width;
    final height = notchMode
        ? switch (_islandView) {
            _IslandView.bar => _notchHeight,
            _IslandView.stack => _notchHeight + 406,
            _IslandView.approval => _notchHeight + 216,
          }
        : switch (_islandView) {
            _IslandView.bar => _menuBarHeight,
            _IslandView.stack => 440.0,
            _IslandView.approval => 250.0,
          };
    final x = notchMode
        ? screen['x']! + _islandNotchInfo!['leftAuxWidth']! - 46
        : screen['x']! + (screen['w']! - width) / 2;
    final y = _isMacOS ? screen['y']! + screen['h']! - height : screen['y']!;
    await _windowService.setWindowFrame(x, y, width, height);
  }

  Future<void> _setIslandView(_IslandView view) async {
    if (!_parked || _islandView == view || _windowOpInFlight) return;
    if (view != _IslandView.stack) {
      _islandCollapseTimer?.cancel();
      _islandHoverExpanded = false;
    }
    if (view == _IslandView.bar) {
      _islandPinned = false;
      _windowService.resignKeyWindow();
    }
    _windowOpInFlight = true;
    setState(() => _islandView = view);
    await _placeIslandFrame();
    _windowOpInFlight = false;
  }

  Future<void> _snapIslandToNotch() async {
    if (!_parked || _windowOpInFlight) return;
    _windowOpInFlight = true;
    await _placeIslandFrame();
    _windowOpInFlight = false;
  }

  Future<void> _unparkIsland({bool byUser = false}) async {
    if (!_parked) return;
    if (byUser) {
      _unparkedByUser = true;
      _settingsService.setNotchParked(false);
    }
    _pinnedByUser = false;
    _islandPinned = false;
    _islandHoverExpanded = false;
    _islandCollapseTimer?.cancel();
    _resolutionTimer?.cancel();
    final frame = _preParkFrame;
    setState(() {
      _parked = false;
      _islandView = _IslandView.bar;
      _resolvedApproval = null;
      _approvalResolution = null;
    });
    if (frame != null) {
      while (_windowOpInFlight) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      _windowOpInFlight = true;
      if (_isMacOS) await _windowService.setNotchParked(false);
      await _windowService.setWindowFrame(
        frame['x']!,
        frame['y']!,
        frame['w']!,
        frame['h']!,
      );
      _windowOpInFlight = false;
    } else if (_isMacOS) {
      await _windowService.setNotchParked(false);
    }
    _preParkFrame = null;
    _islandScreenFrame = null;
    _islandNotchInfo = null;
    _islandSnappedWidth = null;
  }

  void _onIslandEnter(PointerEnterEvent event) {
    _islandCollapseTimer?.cancel();
    if (!_parked) return;
    if (_islandView == _IslandView.bar) {
      _islandHoverExpanded = true;
      _setIslandView(_IslandView.stack);
    }
  }

  void _onIslandExit(PointerExitEvent event) {
    if (!_islandHoverExpanded ||
        _islandPinned ||
        _islandView == _IslandView.approval) {
      return;
    }
    _islandCollapseTimer?.cancel();
    _islandCollapseTimer = Timer(const Duration(milliseconds: 400), () {
      if (!mounted ||
          !_parked ||
          !_islandHoverExpanded ||
          _islandPinned ||
          _islandView == _IslandView.approval) {
        return;
      }
      _setIslandView(_IslandView.bar);
    });
  }

  void _pinIsland() {
    _islandCollapseTimer?.cancel();
    _islandHoverExpanded = false;
    _islandPinned = true;
    _windowService.makeKeyWindow();
  }

  void _collapseIsland() {
    _islandPinned = false;
    _islandHoverExpanded = false;
    _islandCollapseTimer?.cancel();
    _setIslandView(_IslandView.bar);
  }

  void _onIslandDragUpdate(DragUpdateDetails details) {
    _islandDragDistance += details.delta.dy.abs();
    _windowService.moveWindowBy(
      details.delta.dx,
      _isMacOS ? -details.delta.dy : details.delta.dy,
    );
  }

  void _onIslandDragEnd(DragEndDetails details) {
    final shouldUnpark = _islandDragDistance > 40;
    _islandDragDistance = 0;
    if (shouldUnpark) {
      _unparkIsland(byUser: true);
    } else {
      _snapIslandToNotch();
    }
  }

  void _replyToIslandApproval(
    AgentApprovalRequest request,
    String behavior, {
    String? answer,
  }) {
    final label = switch (behavior) {
      'always' => 'Always allowed',
      'deny' => 'Denied',
      _ => 'Allowed',
    };
    setState(() {
      _resolvedApproval = request;
      _approvalResolution = label;
    });
    context
        .read<WebSocketService>()
        .sendAgentApprovalReply(request.id, behavior, answer: answer);
    _resolutionTimer?.cancel();
    _resolutionTimer = Timer(const Duration(milliseconds: 2500), () {
      if (!mounted || _resolvedApproval?.id != request.id) return;
      setState(() {
        _resolvedApproval = null;
        _approvalResolution = null;
      });
      _setIslandView(_IslandView.bar);
    });
  }

  void toggleVisibility(bool visible) {
    if (visible) {
      // Restore to last visible state and resize window accordingly
      setState(() => _state = _lastVisibleState);
      _settingsService.setHudState(_lastVisibleState);
      _windowService.showWindow();
      _resizeWindowForState(_lastVisibleState);
      _syncIslandFromWs(context.read<WebSocketService>());
    } else {
      if (_parked) {
        _unparkIsland().then((_) {
          if (mounted) toggleVisibility(false);
        });
        return;
      }
      _lastVisibleState = _state;
      setState(() => _state = HudState.hidden);
      _settingsService.setHudState(HudState.hidden);
      _windowService.hideWindow();
    }
  }

  void toggleChat() {
    if (_state == HudState.chat) {
      _transitionTo(HudState.eye);
    } else {
      _transitionTo(HudState.chat);
    }
  }

  /// Two-state toggle: Eye ⇄ Chat. There's no middle controls mode — the
  /// eye simply collapses/uncollapses the chat. (Hotkey-driven.)
  void cycleState() {
    if (_state == HudState.hidden) {
      toggleVisibility(true); // unhide first
      return;
    }
    toggleChat();
  }

  /// Reset window position to default bottom-right corner.
  /// Clears persisted position so next launch uses native default.
  Future<void> resetPosition() async {
    if (_parked) await _unparkIsland(byUser: true);
    _settingsService.setEyePosition(-1, -1);
    if (_state != HudState.eye) _transitionTo(HudState.eye);
    // The native AppDelegate sets default position on launch.
    // For runtime reset, we ask native to re-position via a special method.
    await _windowService.resetToDefaultPosition();
  }

  /// Transition to Chat state and focus the command input.
  void focusInput() {
    if (_state != HudState.chat) {
      _transitionTo(HudState.chat);
    }
    // Delay to let the widget tree rebuild before requesting focus
    Future.delayed(const Duration(milliseconds: 200), () {
      _commandFocusNode.requestFocus();
    });
  }

  Future<void> _persistEyePosition() async {
    final frame = await _windowService.getWindowFrame();
    if (frame != null && mounted) {
      _settingsService.setEyePosition(frame['x']!, frame['y']!);
    }
  }

  /// Eye drag finished: dropping it in the notch zone (top edge, middle third
  /// of the screen) parks it as the island — the symmetric gesture to
  /// drag-to-unpark. Elsewhere, persist the position as usual.
  Future<void> _onEyeDragEnd() async {
    final frame = await _windowService.getWindowFrame();
    if (frame == null || !mounted) return;
    final screen = await _windowService.getScreenFrame();
    if (screen != null && _inParkZone(frame, screen)) {
      await _manualParkIsland(frame: frame);
      return;
    }
    _settingsService.setEyePosition(frame['x']!, frame['y']!);
  }

  Future<void> _manualParkIsland({Map<String, double>? frame}) async {
    final currentFrame = frame ?? await _windowService.getWindowFrame();
    if (currentFrame == null || !mounted) return;
    // Manual park pins the island: it stays parked even with no agent
    // sessions (eye-only pill) and idle never auto-unparks it.
    _pinnedByUser = true;
    _unparkedByUser = false;
    final s = _settingsService.settings;
    await _parkIsland(
      homeFrame: s.eyeX >= 0 && s.eyeY >= 0
          ? {
              'x': s.eyeX,
              'y': s.eyeY,
              'w': currentFrame['w']!,
              'h': currentFrame['h']!,
            }
          : null,
    );
  }

  bool _inParkZone(Map<String, double> frame, Map<String, double> screen) {
    final centerX = frame['x']! + frame['w']! / 2;
    final third = screen['w']! / 3;
    final inMiddleThird =
        centerX >= screen['x']! + third && centerX <= screen['x']! + 2 * third;
    final windowTop = frame['y']! + frame['h']!;
    final screenTop = screen['y']! + screen['h']!;
    final nearTop = _isMacOS
        ? windowTop >= screenTop - 80
        : frame['y']! <= screen['y']! + 80;
    return inMiddleThird && nearTop;
  }

  void _transitionTo(HudState target) {
    if (_state == target) return;
    if (_parked && target != HudState.eye) {
      _unparkIsland().then((_) {
        if (mounted) _transitionTo(target);
      });
      return;
    }
    HudTooltip.dismissAll();
    setState(() {
      // A user uncollapse (eye/controls → chat) lands on the sessions list
      // (product call 2026-07-16); programmatic handoffs into the chat go
      // through _leaveCardModeFor, which selects the conversation instead.
      if (target == HudState.chat &&
          (_state == HudState.eye ||
              _state == HudState.hidden ||
              _state == HudState.controls)) {
        _sessionsTab = true;
      }
      _state = target;
    });
    _settingsService.setHudState(target);
    _resizeWindowForState(target);

    if (target == HudState.chat) {
      _windowService.makeKeyWindow();
    } else {
      _windowService.resignKeyWindow();
    }
  }

  Future<void> _resizeWindowForState(HudState state) async {
    final frame = await _windowService.getWindowFrame();
    if (frame == null) return;

    // Anchor every transition to the TOP-RIGHT corner. macOS frames are
    // bottom-left origin, so the previous code kept frame.y (the BOTTOM edge)
    // fixed — collapsing a tall chat to a 48px eye then left the eye at the
    // chat's bottom-right. Pinning the top-right instead puts the eye where the
    // chat's top-right corner was (matching how region-eye chats open downward
    // from the eye), and makes collapse⇄expand return to the exact same rect.
    // top = y + h; new origin.y = top - newHeight keeps the top edge fixed.
    final right = frame['x']! + frame['w']!;
    final top = frame['y']! + frame['h']!;
    void place(double w, double h) =>
        _windowService.setWindowFrame(right - w, top - h, w, h);

    switch (state) {
      case HudState.eye:
        place(48, 48);
      case HudState.controls:
        place(360, 48);
      case HudState.chat:
        place(
          _settingsService.settings.chatWidth,
          _settingsService.settings.chatHeight,
        );
      case HudState.hidden:
        break;
    }
  }

  /// Send a follow-up message to a region's agent thread (stable per-ROI
  /// session core-side) and flip its eye badge to working.
  void _sendToRegionThread(String regionId, String text) {
    setState(() => _startedRegionThreads.add(regionId));
    context.read<WebSocketService>().sendSpawnCommand(text, regionId: regionId);
    _regionEyes?.markWorking(regionId);
  }

  /// Switch the chat to a thread tab (null = MAIN feed).
  void _selectThread(String? id) {
    final ws = context.read<WebSocketService>();
    setState(() {
      _sessionsTab = false; // any thread tab leaves the sessions view
      _activeThread = id;
      if (id == null) {
        _activeRegion = null;
      } else if (_activeRegion?.id != id) {
        // Re-resolve the live region for the banner (null if expired)
        RegionHighlight? live;
        for (final r in ws.regions) {
          if (r.id == id) live = r;
        }
        _activeRegion = live;
      }
    });
    _syncBusyState();
  }

  void _closeThread(String id) {
    context.read<WebSocketService>().closeRegionThread(id);
    ThreadTerminalSession.close(id); // kill the thread's PTY, if any
    setState(() {
      _terminalThreads.remove(id);
      // Drop the "started" mark too — otherwise the gate in _buildThreadTabs
      // (which keys off _startedRegionThreads) would resurrect the closed tab.
      _startedRegionThreads.remove(id);
      if (_activeThread == id) {
        _activeThread = null;
        _activeRegion = null;
      }
    });
    _syncBusyState();
  }

  /// Manual ROI capture — drag-select a screen region, then the toolbar under
  /// the box picks Chat/Term. Triggered by the ⊕ tab pill and by double-tapping
  /// the main eye. The freshly-created r-man-* region is picked up in the
  /// regionStream listener, which opens it in the chosen mode.
  ///
  /// [immediate] (capture-menu flow) skips the toolbar: the selector resolves
  /// on mouse-up and the context card follows the drop.
  Future<void> _startManualRoi({bool immediate = false}) async {
    final ws = context.read<WebSocketService>();
    final res = await _windowService.selectRegion(immediate: immediate);
    if (res == null) return; // cancelled (Esc / ✕)
    // The toolbar under the box returns the destination: 'chat' | 'term' |
    // 'copy' (copy the seed to the clipboard).
    final mode = res['mode'] as String?;
    _pendingManualMode = (mode == 'term' || mode == 'copy') ? mode! : 'chat';
    // Remember where to teleport the HUD: the selection's bottom-left corner
    // (selector reports main-display, top-left-origin points → display 0).
    final rx = (res['x'] as num?)?.toDouble() ?? 0;
    final ry = (res['y'] as num?)?.toDouble() ?? 0;
    final rh = (res['h'] as num?)?.toDouble() ?? 0;
    _pendingManualPos = Offset(rx, ry + rh);
    // Snapshot existing manual ROIs so the broadcast handler can tell the new
    // one apart from earlier ones still in the region list.
    _manualIdsBefore = ws.regions
        .where((r) => r.id.startsWith('r-man-'))
        .map((r) => r.id)
        .toSet();
    _awaitingManualRegion = true;
    // Forward only the numeric rect fields; 'mode' is overlay-local.
    ws.sendRegionSelect(<String, double>{
      for (final e in res.entries)
        if (e.value is double) e.key: e.value as double,
    });
  }

  /// Tab key for the terminal toggle — MAIN uses a stable pseudo-id so the
  /// spike can be exercised without waiting for a region thread.
  String get _activeTabKey => _activeThread ?? 'main';

  /// Tell core whether the user is conversing in a terminal right now.
  /// Visible terminal → hold ambient escalations (refreshed by the 30s
  /// heartbeat); anything else → release the quiet window immediately so
  /// returning to chat doesn't leave a stale ~3 min suppression tail.
  void _syncBusyState() {
    final ws = context.read<WebSocketService>();
    if (_terminalThreads.contains(_activeTabKey) && _state != HudState.hidden) {
      ws.sendUserBusy();
    } else {
      ws.sendUserBusy(0);
    }
  }

  /// Open (or surface) the terminal for a tab: MAIN gets the escalation-lane
  /// agent seeded with the current digest; a region tab gets the spawn-lane
  /// agent seeded with the composed region context — the same seeds chat
  /// mode uses. run.sh resolves lanes/profiles; the session is cached, so
  /// re-opening an existing tab just switches the view back.
  void _openTerminalForTab(String tabKey) {
    final runSh = ThreadTerminalSession.findRunSh();
    final isMain = tabKey == 'main';
    ThreadTerminalSession.of(
      tabKey,
      command: runSh != null ? 'bash' : null,
      args: runSh != null
          ? [
              runSh,
              if (isMain) '--interactive-main' else '--interactive-region',
              if (!isMain) tabKey,
            ]
          : null,
      banner: runSh == null
          ? '⚠ sinain-agent-runner/run.sh not found — plain shell. '
              'Dev builds need SINAIN_AGENT_RUNSH=<repo>/sinain-agent-runner/run.sh'
          : null,
    );
    context.read<WebSocketService>().sendUserBusy();
    setState(() {
      if (!isMain) _startedRegionThreads.add(tabKey);
      _terminalThreads.add(tabKey);
    });
  }

  /// Hand the ACTIVE thread off to another agent — the composer's ⑂ control.
  /// Terminal target: switch the terminal lane and open (or surface) the PTY
  /// for this tab, which run.sh seeds with the thread's context. Chat target:
  /// set a PER-THREAD chat-agent override (not the global lane) so this thread's
  /// follow-ups route to the new agent while other threads + ambient escalations
  /// keep the default; then close any open terminal so one session never has two
  /// writers. The transcript (when included) is carried so the destination
  /// continues the conversation.
  void _handoffThread({
    required String agent,
    required bool isTerminal,
    required bool includeTranscript,
  }) {
    final ws = context.read<WebSocketService>();
    final tabKey = _activeTabKey;
    final thread = _activeThread;
    // Carry the conversation so the destination agent continues the thread
    // rather than cold-starting. Sent FIRST so core has it stashed before the
    // destination's seed is built — the terminal pull, desktop seed, and chat
    // kickoff that follow all run after this command on the same socket.
    if (includeTranscript) {
      final items = thread != null
          ? (ws.regionThreads[thread] ?? const <FeedItem>[])
          : ws.agentFeedItems;
      final transcript = _composeTranscript(items);
      if (transcript.isNotEmpty) {
        ws.sendCommand('set_handoff_context',
            {'key': thread ?? 'main', 'transcript': transcript});
      }
    }
    if (isTerminal) {
      ws.setAgent('terminal', agent);
      _openTerminalForTab(tabKey); // seeds this thread's context into the PTY
      _syncBusyState();
      return;
    }
    // Chat handoff: set a per-thread override (NOT the global lane), then fire
    // one kickoff turn so the new agent actually picks up this thread. Both are
    // applied by core in order on the same socket before routing — crucially, a
    // desktop agent (Claude Desktop / ChatGPT) only launches its app when a turn
    // is sent (routeDesktopChat). Without the kickoff the handoff would just set
    // the override and nothing would open.
    if (_terminalThreads.contains(tabKey)) {
      ThreadTerminalSession.close(tabKey);
      setState(() => _terminalThreads.remove(tabKey));
    }
    ws.sendCommand(
        'set_thread_agent', {'key': thread ?? 'main', 'agent': agent});
    // Kickoff turn — core seeds the real context (region ROI / main digest) plus
    // the carried transcript so the destination continues the conversation.
    const kickoff = '[handoff] continue this thread';
    if (thread != null) {
      _sendToRegionThread(thread, kickoff);
    } else {
      ws.sendUserCommand(kickoff);
    }
    _syncBusyState();
  }

  /// Format a thread's feed items into a compact dialogue transcript for a
  /// handoff. Caps to the recent turns + a char budget so the WS payload and
  /// the destination seed stay reasonable.
  String _composeTranscript(List<FeedItem> items) {
    final recent = items.length > 40 ? items.sublist(items.length - 40) : items;
    final buf = StringBuffer();
    for (final it in recent) {
      final text = it.text.trim();
      if (text.isEmpty) continue;
      buf.writeln('${it.isUserOriginated ? 'User' : 'sinain'}: $text');
      buf.writeln();
    }
    var out = buf.toString().trim();
    const maxChars = 6000;
    if (out.length > maxChars) {
      out =
          '…(earlier turns trimmed)…\n\n${out.substring(out.length - maxChars)}';
    }
    return out;
  }

  /// Build the portable seed for [key] (regionId or "main") server-side and
  /// copy it to the clipboard — for agents we don't integrate with (paste it
  /// anywhere). Shared by the ROI card, the handoff popover, and the hotkey.
  Future<void> _copySeed(
      {required String key, String? transcript, VoidCallback? onDone}) async {
    final ws = context.read<WebSocketService>();
    // Building the seed can take a few seconds on a cold cache. Put a
    // placeholder on the clipboard NOW so an early paste lands a helpful note
    // instead of stale/empty content — then swap in the real seed when ready.
    // (A warm cache overwrites this within ~100ms, so the user never sees it.)
    await Clipboard.setData(const ClipboardData(
      text:
          '⏳ Sinain context is being prepared — paste again in a couple of seconds.',
    ));
    try {
      final text = await ws.fetchSeedText(key, transcript: transcript);
      await Clipboard.setData(ClipboardData(
        text: (text != null && text.isNotEmpty)
            ? text
            : '⚠ Sinain couldn\'t prepare this context. Try Copy again.',
      ));
    } catch (_) {
      await Clipboard.setData(const ClipboardData(
        text: '⚠ Sinain couldn\'t prepare this context. Try Copy again.',
      ));
    } finally {
      // Always fire — the UI must clear its loading state even on failure.
      onDone?.call();
    }
  }

  /// Copy the seed for the active thread (region or MAIN), carrying its
  /// transcript. Wired to the global "copy seed" hotkey and the handoff popover.
  Future<void> _copySeedForActiveThread() async {
    final ws = context.read<WebSocketService>();
    final thread = _activeThread;
    final items = thread != null
        ? (ws.regionThreads[thread] ?? const <FeedItem>[])
        : ws.agentFeedItems;
    final t = _composeTranscript(items);
    await _copySeed(key: thread ?? 'main', transcript: t.isEmpty ? null : t);
  }

  /// Public entry for the global "copy seed" hotkey (main.dart → hotkey channel).
  void copySeedHotkey() => _copySeedForActiveThread();

  /// Global Ctrl+Opt+Cmd+C hotkey: enrich whatever's on the clipboard with
  /// Sinain's situational + KG context (treating the copied text like an ROI),
  /// then write back "your content + Sinain seed" so the next paste is already
  /// enriched. The original clipboard is left untouched if it's empty/non-text
  /// or enrichment fails — and we don't pre-clobber it, so an early paste still
  /// lands the user's own content rather than a placeholder.
  Future<void> enrichClipboardHotkey() async {
    // Unified with Build Context: the hotkey opens the card (visible, ~1s);
    // the legacy silent clipboard rewrite lives on as the card's
    // "Copy for agent" action. No more invisible clipboard mutation.
    _enterCardMode();
    await _buildContextFromClipboard();
  }

  /// Divider written before any Sinain-generated clipboard context. Both
  /// clipboard features (seed enrich above, Build-context Copy) use it, so a
  /// single strip at this marker recovers the user's original content.
  static const _sinainContextMarker = '——— Context from Sinain ———';

  static String _stripSinainContext(String text) {
    final i = text.indexOf(_sinainContextMarker);
    return (i < 0 ? text : text.substring(0, i)).trim();
  }

  /// Right-click the eye → a native context menu listing every action, so the
  /// user never has to remember the hotkeys (the menu shows them too). Reuses
  /// the existing handlers; the native NSMenu renders outside the tiny eye panel.
  Future<void> _showEyeContextMenu() async {
    final items = <Map<String, dynamic>>[
      // Deliberate capture — the three window gestures live here, not as
      // dedicated HUD buttons (design: reuse existing controls).
      {'id': 'capSave', 'title': 'Save Context…'},
      // One entry for both call destinations — the chooser card carries a
      // "Call AI" (text handoff) and a "Call sinain" (live voice) button.
      {'id': 'capCall', 'title': 'Call AI…'},
      // The two Context sources sit together: pick a screen region, or take
      // whatever is on the clipboard — both flow into the same enrich card.
      if (_isMacOS) {'id': 'region', 'title': 'Context from Screen…'},
      // Absorbs the former "Enrich Clipboard" (silent seed rewrite): the card's
      // "Copy for agent" action produces the same agent-grade seed, visibly.
      {
        'id': 'capBuild',
        'title': 'Context from Clipboard',
        'key': 'c',
        'mods': ['ctrl', 'opt', 'cmd']
      },
      {'separator': true},
      // The bookmarked-session shelf (§9) — in the eye's menu, not a new
      // surface.
      {'id': 'sessions', 'title': 'Bookmarked Sessions…'},
      {'id': 'copySeed', 'title': 'Copy Context Seed'},
      {'separator': true},
      if (!_parked) {'id': 'parkNotch', 'title': 'Park at Notch'},
      {
        'id': 'reset',
        'title': 'Reset Window Position',
        'key': 'p',
        'mods': ['shift', 'cmd']
      },
      {'id': 'settings', 'title': 'Settings…'},
      {'id': 'feedback', 'title': 'Send feedback'},
      {'separator': true},
      {'id': 'quit', 'title': 'Quit Sinain'},
    ];
    final selected = await _windowService.showContextMenu(items);
    if (!mounted || selected == null) return;
    switch (selected) {
      case 'capSave':
        _enterCardMode();
        await _openRangeChooser('save');
      case 'capCall':
        _enterCardMode();
        await _openRangeChooser('call');
      case 'capBuild':
        _enterCardMode();
        await _buildContextFromClipboard();
      case 'region':
        // Selection FIRST — the drag defines the subject; the enrich card
        // (card mode) follows with the region as its focus. A default-range
        // window brief is prefetched for the region thread's opening context.
        await _startRegionSelect();
      case 'sessions':
        await _showSessionShelf();
      case 'copySeed':
        await _copySeedForActiveThread();
      case 'parkNotch':
        await _manualParkIsland();
      case 'reset':
        await resetPosition();
      case 'settings':
        _openSettings();
      case 'feedback':
        await _openFeedbackUrl(HudConstants.feedbackIssueUrl);
      case 'quit':
        await quitApp();
    }
  }

  /// True while any spawn task for this region is still in flight.
  bool _regionWorking(WebSocketService ws, String regionId) {
    for (final t in ws.spawnTasks.values) {
      if (t.regionId == regionId && !t.isTerminal) return true;
    }
    return false;
  }

  /// Horizontal tab bar: MAIN + one pill per STARTED region thread. A tab
  /// appears only once a region's thread is actually started — chat Run / a
  /// sent message / an opened terminal (`_startedRegionThreads`), or live
  /// thread messages (`regionThreads`). Merely tapping an eye registers a
  /// label but must NOT spawn a tab, or the strip fills with not-started
  /// threads the user never opened.
  /// Resolve a region thread's full (untruncated) title from the live labels,
  /// falling back to the region's issue. Shared by the tab strip and the
  /// solid-mode chat card header.
  String _threadTitleFor(WebSocketService ws, String id) {
    var label = ws.regionThreadLabels[id];
    if (label == null || label.isEmpty) {
      for (final r in ws.regions) {
        if (r.id == id) {
          label = r.issue;
          break;
        }
      }
    }
    if ((label == null || label.isEmpty) && _activeRegion?.id == id) {
      label = _activeRegion!.issue;
    }
    return (label == null || label.isEmpty) ? 'region' : label;
  }

  Widget _buildThreadTabs(WebSocketService ws) {
    final theme = HudTheme.of(context);
    final ids = <String>{
      ...ws.regionThreads.keys,
      ..._startedRegionThreads,
    }.toList();
    // The strip is always shown: SESSIONS and MAIN are two permanent tabs
    // (the sessions list is the default uncollapsed view).

    String labelFor(String id) {
      final label = _threadTitleFor(ws, id);
      return label.length > 18 ? '${label.substring(0, 18)}…' : label;
    }

    Widget pill({
      required String text,
      required bool selected,
      required VoidCallback onTap,
      VoidCallback? onClose,
    }) {
      final accent = _accentColor;
      return Padding(
        padding: const EdgeInsets.only(right: 4),
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: selected
                    ? (theme.isSolid
                        ? theme.selectionAccent.withValues(alpha: 0.18)
                        : accent.withValues(alpha: 0.15))
                    : (theme.isSolid
                        ? theme.bubbleBg
                        : Colors.white.withValues(alpha: 0.04)),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: selected
                      ? (theme.isSolid
                          ? theme.selectionAccent.withValues(alpha: 0.6)
                          : accent.withValues(alpha: 0.5))
                      : theme.border,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    text,
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: selected
                          ? (theme.isSolid ? theme.selectionAccent : accent)
                          : theme.textMuted,
                      fontWeight:
                          selected ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                  if (onClose != null) ...[
                    const SizedBox(width: 5),
                    GestureDetector(
                      onTap: onClose,
                      child: Icon(Icons.close,
                          size: 9, color: Colors.white.withValues(alpha: 0.4)),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      height: 26,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      child: Row(children: [
        Expanded(
            child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              pill(
                text: 'SESSIONS',
                selected: _sessionsTab,
                onTap: () => setState(() => _sessionsTab = true),
              ),
              pill(
                text: 'MAIN',
                selected: !_sessionsTab && _activeThread == null,
                onTap: () => _selectThread(null),
              ),
              for (final id in ids)
                pill(
                  // ⟳ while this region's task is in flight — visible feedback
                  // that the agent is working. No eye glyph otherwise: the label
                  // alone names the tab.
                  text: '${_regionWorking(ws, id) ? "⟳ " : ""}${labelFor(id)}',
                  selected: !_sessionsTab && _activeThread == id,
                  onTap: () => _selectThread(id),
                  onClose: () => _closeThread(id),
                ),
            ],
          ),
        )),
        // Manual ROI: drag-select a screen region to start a thread from its
        // content — the counterpart to auto-detected eyes.
        pill(
          text: '⊕',
          selected: false,
          onTap: _startManualRoi,
        ),
        // (The ⑂ fork pill moved into the chat composer as the inline-left
        // "continue this thread elsewhere" handoff control — see
        // ChatThreadView.onHandoff / _handoffThread.)
        // Chat ⇄ terminal toggle for the ACTIVE tab — pinned at the right
        // edge, outside the scrolling tab strip, so a crowd of tabs can
        // never squeeze it out of sight. Term→chat closes the PTY so one
        // session never has two concurrent writers (P3 exclusivity).
        if (terminalSpikeEnabled)
          pill(
            text:
                _terminalThreads.contains(_activeTabKey) ? '💬 chat' : '⌨ term',
            selected: _terminalThreads.contains(_activeTabKey),
            onTap: () {
              if (_terminalThreads.contains(_activeTabKey)) {
                ThreadTerminalSession.close(_activeTabKey);
                setState(() => _terminalThreads.remove(_activeTabKey));
              } else {
                _openTerminalForTab(_activeTabKey);
              }
              _syncBusyState();
            },
          ),
      ]),
    );
  }

  /// Move the HUD next to a region eye (top-left-origin screen point) and
  /// open the chat there. Used by region eye taps — the chat becomes the
  /// viewport for that region's conversation.
  Future<void> _openChatNearRegion(double x, double y,
      [int display = 0]) async {
    if (_state == HudState.hidden) toggleVisibility(true);

    final chatW = _settingsService.settings.chatWidth;
    final chatH = _settingsService.settings.chatHeight;

    // Resolve the eye's display (multi-display): x/y are top-left WITHIN that
    // display, so the chat must be clamped to that display and converted to its
    // global Cocoa origin — otherwise it opens on the main display.
    final screens = await _windowService.getScreens();
    Map<String, double>? scr;
    if (screens != null && screens.isNotEmpty) {
      if (display != 0) {
        for (final s in screens) {
          if (s['id'] == display.toDouble()) {
            scr = s;
            break;
          }
        }
      }
      scr ??= screens.firstWhere((s) => s['x'] == 0 && s['y'] == 0,
          orElse: () => screens.first);
    } else {
      final size = await _windowService.getScreenSize();
      if (size != null) {
        scr = {'id': 0.0, 'x': 0.0, 'y': 0.0, 'w': size['w']!, 'h': size['h']!};
      }
    }
    if (scr != null) {
      final sw = scr['w']!, sh = scr['h']!, ox = scr['x']!, oy = scr['y']!;
      // Chat below the eye, right edge roughly aligned with it (within-display).
      final left = (x + 48 - chatW).clamp(8.0, sw - chatW - 8);
      final top = (y + 56).clamp(8.0, sh - chatH - 8);
      // top-left within display → global macOS bottom-left origin.
      final globalX = ox + left;
      final globalY = oy + (sh - top - chatH);
      await _windowService.setWindowFrame(globalX, globalY, chatW, chatH);
    }

    if (_state != HudState.chat) {
      HudTooltip.dismissAll();
      setState(() => _state = HudState.chat);
      _settingsService.setHudState(HudState.chat);
    }
    _windowService.makeKeyWindow();
  }

  @override
  void dispose() {
    _busyTimer?.cancel();
    _regionEyes?.dispose();
    _thinkingSub?.cancel();
    _forkSub?.cancel();
    _manualRegionSub?.cancel();
    _contentSub?.cancel();
    _contentResetTimer?.cancel();
    _briefSub?.cancel();
    _enrichSub?.cancel();
    _enrichChipTimer?.cancel();
    _receiptSub?.cancel();
    _voiceSub?.cancel();
    _offerSub?.cancel();
    _offerExpiryTimer?.cancel();
    _resolutionTimer?.cancel();
    _islandCollapseTimer?.cancel();
    _nudgeSub?.cancel();
    _chipSub?.cancel();
    _wrapSub?.cancel();
    _assistSub?.cancel();
    _nudgeExpiryTimer?.cancel();
    if (_wsForListener != null && _wsListener != null) {
      _wsForListener!.removeListener(_wsListener!);
    }
    _commandFocusNode.dispose();
    super.dispose();
  }

  // ── Deliberate capture handlers ──

  /// Open the range chooser for 'save' or 'summon'; coverage strings are free
  /// window data (no LLM) so fetching them on open is cheap.
  Future<void> _openRangeChooser(String action) async {
    setState(() => _chooserFor = _chooserFor == action ? null : action);
    if (_chooserFor == null) return;
    final options = await context.read<WebSocketService>().fetchRangeOptions();
    if (mounted && _chooserFor != null) {
      setState(() => _rangeOptions = options);
    }
  }

  Future<void> _pickRange(int minutes, List<String>? apps) async {
    final action = _chooserFor;
    final adjusting = _adjustingOfferId;
    setState(() => _chooserFor = null);
    final ws = context.read<WebSocketService>();
    if (action == 'save') {
      if (adjusting != null) {
        // Adjusted offer: same save lifecycle, but the response is a
        // correction label — unticked proposed apps become durable
        // exclusions for this thread core-side.
        _clearAdjustState();
        await ws.respondToOffer(adjusting, 'adjusted',
            minutes: minutes, apps: apps);
      } else {
        await ws.requestSave(minutes, apps: apps);
      }
      // Receipt lifecycle arrives via saveReceiptStream.
    } else if (action == 'call') {
      final err = await ws.requestSummon(minutes, apps: apps);
      if (err != null && mounted) {
        setState(() => _activeBrief = ContextBrief(
              requestId: 'local',
              status: CardStatus.error,
              minutes: minutes,
              coverage: '',
              error: err,
            ));
      }
    }
  }

  /// "Select Region…" (menu): straight into the native drag-select; the
  /// enrich card follows the drop. A brief of the last N minutes is kicked
  /// off NOW so it's usually ready when the drag lands — the region handler
  /// stashes it into the thread. Brief errors degrade to a plain region
  /// grab; the selection is never blocked on the LLM.
  static const _regionBriefMinutes = 30;

  Future<void> _startRegionSelect() async {
    final ws = context.read<WebSocketService>();
    _regionBriefPending = true;
    _regionViaMenu = true;
    _pendingRegionBrief = null;
    _regionBriefTarget = null;
    ws.requestSummon(_regionBriefMinutes).then((err) {
      if (err != null) _regionBriefPending = false;
    });
    // No toolbar under the box: releasing the drag is the confirmation, the
    // enrich card appears right away.
    await _startManualRoi(immediate: true);
  }

  /// "Call sinain": a live call FROM THIS MACHINE — screen + mic over WebRTC
  /// to the sinain server (mechanics like a meeting, nothing to do with Meet).
  /// If the server wants a session, login happens in the user's DEFAULT
  /// browser (already signed into Google/Auth0 → usually zero-click): the
  /// server's /hud/pair page mints a device token and hands it to core; we
  /// poll until paired and redial. (A WKWebView fallback exists in
  /// WindowService, but Google blocks OAuth in embedded webviews.)
  Future<void> _callSinain(int minutes,
      {List<String>? apps, bool retried = false}) async {
    final ws = context.read<WebSocketService>();
    final resp = await ws.requestVoiceStart(minutes, apps: apps);
    final error = resp == null
        ? 'core unreachable'
        : (resp['ok'] == true ? null : (resp['error'] as String? ?? 'failed'));
    if (error == null) {
      // Webview engine: core owns the session; we host the invisible
      // WKWebView that runs the browser WebRTC stack on core's call page.
      if (resp?['engine'] == 'webview') {
        final base = ws.httpBase ?? 'http://localhost:9500';
        final opened =
            await _windowService.openCallEngine('$base/voice/call.html');
        if (!opened) ws.requestVoiceStop();
      }
      return; // lifecycle continues on voiceSessionStream
    }

    final loginUrl = resp?['loginUrl'] as String?;
    if (loginUrl != null && !retried) {
      // DEFAULT browser — the user is usually already signed in there, so
      // this is typically zero-click. The pair page hands the credential to
      // core out-of-band; poll until paired, then redial automatically.
      await launchUrl(Uri.parse(loginUrl));
      for (var i = 0; i < 60; i++) {
        await Future.delayed(const Duration(seconds: 2));
        if (!mounted) return;
        final status = await ws.fetchVoiceStatus();
        if (status?['paired'] == true) {
          await _callSinain(minutes, apps: apps, retried: true);
          return;
        }
      }
    }
    if (!mounted) return;
    setState(() => _voiceSession = VoiceSession(
          status: VoiceStatus.error,
          mode: VoiceMode.bridge,
          minutes: minutes,
          coverage: '',
          error: loginUrl != null
              ? 'login not completed — finish signing in, then call again'
              : error,
        ));
    _enterCardMode();
  }

  /// "Build context" — enrich whatever is on the clipboard with the last
  /// 10 minutes of window context.
  Future<void> _buildContextFromClipboard() async {
    final ws = context.read<WebSocketService>();
    final clip = await Clipboard.getData(Clipboard.kTextPlain);
    // Strip any previous Sinain context block — otherwise re-invoking after a
    // Copy (or the seed-enrich hotkey) feeds our own output back in and the
    // card compounds instead of enriching the user's original content.
    final text = _stripSinainContext(clip?.text ?? '');
    if (text.isEmpty) {
      setState(() => _activeEnrich = const EnrichCard(
            requestId: 'local',
            status: CardStatus.error,
            focus: '',
            error: 'clipboard is empty — copy something first',
          ));
      return;
    }
    // Keep the untruncated original for Copy — the card's `focus` is a display
    // preview (120 chars) and must never be what lands back on the clipboard.
    _enrichFocusFull = text;
    final err = await ws.requestEnrich(text);
    if (err != null && mounted) {
      setState(() => _activeEnrich = EnrichCard(
            requestId: 'local',
            status: CardStatus.error,
            focus: text.length > 120 ? '${text.substring(0, 117)}…' : text,
            error: err,
          ));
    }
  }

  /// Enrich card → "Call AI": hand the focus item + built context to the
  /// agent lane so there's something to DO with the card.
  void _callAiOnEnrich(EnrichCard c) {
    final ws = context.read<WebSocketService>();
    // Region focus → hand off to the region's own thread (its seed already
    // carries the ROI + the window brief), not MAIN.
    final region = _pendingRegion;
    if (region != null) {
      _pendingRegion = null;
      setState(() {
        _activeEnrich = null;
        _startedRegionThreads.add(region.id);
      });
      _regionEyes?.run(region);
      if (!ws.escalationDesktop) _selectThread(region.id);
      _leaveCardModeFor(HudState.chat);
      return;
    }
    final msg = StringBuffer()
      ..writeln('I copied this: ${_enrichFocusFull ?? c.focus}')
      ..write('Context: ${c.context}');
    ws.sendUserCommand(msg.toString());
    setState(() => _activeEnrich = null);
    _leaveCardModeFor(HudState.chat); // follow the conversation
  }

  /// Enrich card → "Copy for agent": the FULL original item + BOTH context
  /// layers back onto the clipboard, ready to paste into an external agent:
  ///   1. the card's burst CONTEXT — item-specific, assembled at gesture time
  ///      ("this is X, tied to Y") — the seed never mentions the copied item;
  ///   2. the agent-grade seed (/seed: situation digest + KG facts) — the
  ///      general scene + knowledge, item-agnostic and built at the last
  ///      analyzer tick.
  /// Complementary, not redundant. If the seed build fails, layer 1 still
  /// makes the paste useful.
  Future<void> _copyEnrichCard(EnrichCard c) async {
    final ws = context.read<WebSocketService>();
    final original = _enrichFocusFull ?? c.focus;
    final seed = await ws.fetchSeedText('clipboard', focus: original);
    final block = StringBuffer()..write('About this item: ${c.context}');
    if (seed != null && seed.trim().isNotEmpty) {
      block
        ..writeln()
        ..writeln()
        ..write(seed.trim());
    }
    await Clipboard.setData(
        ClipboardData(text: '$original\n\n$_sinainContextMarker\n$block'));
    if (mounted) {
      setState(() => _activeEnrich = null);
      _maybeExitCardMode();
    }
  }

  /// Display name of the agent the current summon destination opens in —
  /// the handoff button says where the brief will land.
  String _handoffAgentLabel(WebSocketService ws) {
    final id = _summonDest == 'term' ? ws.terminalAgent : ws.escalationAgent;
    return switch (id) {
      'sinain' => 'Sinain Chat',
      'claude' => 'Claude Code',
      'gclaude' => 'Claude',
      'openclaude' => 'OpenClaude',
      'codex' => 'Codex',
      'goose' => 'Goose',
      'junie' => 'Junie',
      'aider' => 'Aider',
      'claude-desktop' => 'Claude Desktop',
      'chatgpt-desktop' => 'ChatGPT',
      _ => id,
    };
  }

  /// Flatten a situation brief into the text form carried into agent seeds
  /// (Ask follow-up, terminal handoff, region + minutes).
  String _briefText(ContextBrief b) {
    final summary = StringBuffer()
      ..writeln('Situation brief of my last ${b.minutes} minutes '
          '(${b.coverage}):');
    if (b.timeline.isNotEmpty) {
      for (final e in b.timeline) {
        summary.writeln('${e.at}: ${e.what}');
      }
    }
    summary.writeln('Goal: ${b.goal}');
    if (b.problems.isNotEmpty) {
      summary.writeln('Open problems: ${b.problems.join('; ')}');
    }
    return summary.toString();
  }

  /// "Ask follow-up" — hand the brief to the chosen destination: the in-HUD
  /// chat lane, or a terminal whose run.sh seed carries the brief (same
  /// set_handoff_context mechanic as the ⑂ handoff).
  void _askFollowUpOnBrief(ContextBrief b) {
    final ws = context.read<WebSocketService>();
    final summary = StringBuffer()
      ..write(_briefText(b))
      ..write('Pick up from here and help me with the next step.');

    if (_summonDest == 'term') {
      // Stash the brief as MAIN's handoff context BEFORE the terminal spawns —
      // run.sh's seed pull happens after this command on the same socket.
      ws.sendCommand('set_handoff_context',
          {'key': 'main', 'transcript': summary.toString()});
      setState(() {
        _activeBrief = null;
        _activeThread = null; // surface the MAIN tab the PTY attaches to
      });
      _leaveCardModeFor(HudState.chat); // the PTY lives in the chat surface
      _openTerminalForTab('main');
      return;
    }
    ws.sendUserCommand(summary.toString());
    setState(() => _activeBrief = null);
    _leaveCardModeFor(HudState.chat); // follow the conversation
  }

  // ── Compact card mode ──
  // Capture gestures triggered outside the chat show their cards in a small
  // dedicated panel instead of forcing the full HUD open. The window grows to
  // card size and shrinks back to the eye when the last card is dismissed.

  void _enterCardMode() {
    if (_state == HudState.chat) return;
    if (!_cardMode) setState(() => _cardMode = true);
    // Always resync: a card arriving while chip-only card mode is open must
    // grow the window back to card height.
    _resizeForCardPanel();
  }

  /// Anything taller than the session chip on the card surface?
  bool get _hasCards =>
      _chooserFor != null ||
      _activeBrief != null ||
      _activeEnrich != null ||
      _saveReceipt != null ||
      _saveOffer != null ||
      _sessionNudge != null ||
      _sessionWrap != null ||
      _sessionShelf != null ||
      _assistVisible ||
      _voiceSession != null;

  Future<void> _resizeForCardPanel() async {
    final frame = await _windowService.getWindowFrame();
    if (frame == null) return;
    final right = frame['x']! + frame['w']!;
    final top = frame['y']! + frame['h']!;
    // The window IS the clickable area — an invisible 380×500 shield blocked
    // clicks to other apps whenever a session chip held card mode open
    // (field 2026-07-16). Chip-only card mode gets a chip-sized window; full
    // height only while actual cards are showing.
    final h = _hasCards ? 500.0 : 120.0;
    _windowService.setWindowFrame(right - 380, top - h, 380, h);
  }

  /// Leave card mode once nothing is displayed; restore the eye-sized window.
  void _maybeExitCardMode() {
    if (!_cardMode) return;
    if (_chooserFor != null ||
        _activeBrief != null ||
        _activeEnrich != null ||
        _saveReceipt != null ||
        _saveOffer != null ||
        _sessionNudge != null ||
        _sessionChips.isNotEmpty ||
        _sessionWrap != null ||
        _sessionShelf != null ||
        _voiceSession != null) {
      // Still showing something — but the content class may have shrunk
      // (last card closed, chip remains): resync the window size so the
      // invisible area never outgrows the visible panel.
      _resizeForCardPanel();
      return;
    }
    setState(() => _cardMode = false);
    _resizeWindowForState(_state);
  }

  // ── Save offer lifecycle (DESIGN-SAVE-OFFER.md) ───────────────────────────

  /// A `save_offer` arrived (arrival A): the card just appears in the card
  /// corner — zero extra gestures. Untouched, it fades silently after ~45 s
  /// (no countdown bar — that idiom is reserved for the receipt's undo).
  void _showSaveOffer(SaveOffer o) {
    _offerExpiryTimer?.cancel();
    setState(() => _saveOffer = o);
    if (_parked) _scheduleIslandResize();
    _offerExpiryTimer = Timer(Duration(seconds: o.expirySeconds), _expireOffer);
    if (_state != HudState.hidden && !_parked) {
      _enterCardMode(); // no-op in chat
    }
  }

  /// Accept: the same save lifecycle as the manual gesture, offered_save
  /// provenance. The receipt replaces the offer in the same stack slot —
  /// one card per save (morph, never stack).
  void _acceptOffer() {
    final o = _saveOffer;
    if (o == null) return;
    context.read<WebSocketService>().respondToOffer(o.offerId, 'accepted');
    _clearOffer(exitSurfaces: false); // receipt arrives on saveReceiptStream
  }

  /// Adjust…: the shipped chooser, pre-filled (N = offer minutes, proposed
  /// sources ticked, everything else — incl. mic — unticked). Confirm posts
  /// "adjusted"; unticked proposed apps become durable exclusions core-side.
  void _adjustOffer() {
    final o = _saveOffer;
    if (o == null) return;
    _offerExpiryTimer?.cancel();
    setState(() {
      _adjustingOfferId = o.offerId;
      _offerPrefillApps = o.apps;
      _offerPrefillMinutes = o.minutes;
      _saveOffer = null;
    });
    _enterCardMode();
    _openRangeChooser('save');
  }

  void _dismissOffer() => _resolveOffer('dismissed');
  void _expireOffer() => _resolveOffer('expired');

  void _resolveOffer(String response) {
    final o = _saveOffer;
    if (o == null || !mounted) return;
    context.read<WebSocketService>().respondToOffer(o.offerId, response);
    _clearOffer();
  }

  void _clearOffer({bool exitSurfaces = true}) {
    _offerExpiryTimer?.cancel();
    setState(() => _saveOffer = null);
    if (_parked) _scheduleIslandResize();
    if (exitSurfaces) _maybeExitCardMode();
  }

  void _clearAdjustState() {
    setState(() {
      _adjustingOfferId = null;
      _offerPrefillApps = null;
      _offerPrefillMinutes = null;
    });
  }

  // ── Session Sense lifecycle (DESIGN-SESSION-SENSE.md) ────────────────────

  /// A `session_nudge` arrived: the credit-led card appears in the card
  /// corner. Untouched, it fades silently after ~45 s (expiry consumes the
  /// episode's one ask — policy A).
  void _showSessionNudge(SessionNudge n) {
    _nudgeExpiryTimer?.cancel();
    setState(() => _sessionNudge = n);
    _nudgeExpiryTimer =
        Timer(Duration(seconds: n.expirySeconds), _expireSessionNudge);
    if (_state != HudState.hidden) _enterCardMode();
  }

  /// Track: one tap, retroactive credit pinned — the chip arrives on
  /// [sessionChipStream] and takes over the ambient state.
  void _trackSession() {
    final n = _sessionNudge;
    if (n == null) return;
    context
        .read<WebSocketService>()
        .respondToSessionNudge(n.nudgeId, 'tracked');
    _clearSessionNudge(exitSurfaces: false); // chip arrives next
  }

  /// The warm session (running beats paused; most recently started wins) —
  /// the one the corner chip and detail card represent.
  SessionChipState? get _warmChip {
    SessionChipState? best;
    for (final c in _sessionChips.values) {
      if (best == null ||
          (!c.paused && best.paused) ||
          (c.paused == best.paused && c.startedTs > best.startedTs)) {
        best = c;
      }
    }
    return best;
  }

  int _nudgeSpanMinutes(SessionNudge n) =>
      ((DateTime.now().millisecondsSinceEpoch - n.candidateStartTs) / 60000)
          .ceil()
          .clamp(1, 120);

  /// ▶ on the nudge (product call 2026-07-16): play = track + Call AI over
  /// the credited span — immediately: the brief hands off to the lane on
  /// arrival, no preview card in between.
  void _playSessionNudge() {
    final n = _sessionNudge;
    if (n == null) return;
    final ws = context.read<WebSocketService>();
    ws.respondToSessionNudge(n.nudgeId, 'tracked');
    _autoHandoffBrief = true;
    ws.requestSummon(_nudgeSpanMinutes(n),
        apps: n.apps.isEmpty ? null : n.apps);
    _clearSessionNudge(exitSurfaces: false); // chip arrives next
  }

  /// "Call Sinain" on the nudge: track + a live voice call on the span.
  void _callSinainOnSessionNudge() {
    final n = _sessionNudge;
    if (n == null) return;
    context
        .read<WebSocketService>()
        .respondToSessionNudge(n.nudgeId, 'tracked');
    final minutes = _nudgeSpanMinutes(n);
    final apps = n.apps.isEmpty ? null : n.apps;
    _clearSessionNudge(exitSurfaces: false);
    unawaited(_callSinain(minutes, apps: apps));
  }

  /// "Wrong?" pick: tracks under the corrected label in the same tap —
  /// correction ≠ dismissal (§3). [label] == '' means "just work — no label".
  void _correctSession(String label) {
    final n = _sessionNudge;
    if (n == null) return;
    context
        .read<WebSocketService>()
        .respondToSessionNudge(n.nudgeId, 'corrected', label: label);
    _clearSessionNudge(exitSurfaces: false);
  }

  void _dismissSessionNudge() => _resolveSessionNudge('dismissed');
  void _expireSessionNudge() => _resolveSessionNudge('expired');

  void _resolveSessionNudge(String response) {
    final n = _sessionNudge;
    if (n == null || !mounted) return;
    context.read<WebSocketService>().respondToSessionNudge(n.nudgeId, response);
    _clearSessionNudge();
  }

  void _clearSessionNudge({bool exitSurfaces = true}) {
    _nudgeExpiryTimer?.cancel();
    setState(() => _sessionNudge = null);
    if (exitSurfaces) _maybeExitCardMode();
  }

  /// Wrap confirm — teaches the boundary; the receipt arrives into the same
  /// stack slot via [saveReceiptStream] (standard save lifecycle).
  void _wrapSession() {
    final w = _sessionWrap;
    if (w == null) return;
    context.read<WebSocketService>().sessionAction(w.sessionId, 'wrapped');
    setState(() => _sessionWrap = null);
  }

  /// "Keep going" — corrects a too-eager decay model; the quiet clock resets.
  void _keepGoingSession() {
    final w = _sessionWrap;
    if (w == null) return;
    context.read<WebSocketService>().sessionAction(w.sessionId, 'keep_going');
    setState(() => _sessionWrap = null);
    _maybeExitCardMode();
  }

  /// ✕ on the wrap card: just hides it — the server's grace period auto-wraps
  /// regardless (a session never runs forever because the user walked away).
  void _dismissWrapCard() {
    setState(() => _sessionWrap = null);
    _maybeExitCardMode();
  }

  /// "⚑ Later" (§9): Wrap up + a promise — the thread gains a bookmark.
  void _wrapSessionLater() {
    final w = _sessionWrap;
    if (w == null) return;
    context.read<WebSocketService>().sessionAction(w.sessionId, 'later');
    setState(() => _sessionWrap = null);
  }

  // ── Bookmarked-sessions shelf (§9) ────────────────────────────────────────

  Future<void> _showSessionShelf() async {
    final ws = context.read<WebSocketService>();
    final rows = await ws.fetchSessionBookmarks();
    if (!mounted) return;
    setState(() => _sessionShelf = rows);
    _enterCardMode();
  }

  void _dismissSessionShelf() {
    setState(() => _sessionShelf = null);
    _maybeExitCardMode();
  }

  /// ▶ on a shelf row: a fresh session on the same thread, immediately —
  /// no detection wait, no nudge. The chip arrives on [sessionChipStream].
  Future<void> _resumeBookmark(SessionBookmark b) async {
    final ws = context.read<WebSocketService>();
    await ws.sessionBookmarkAction(b.threadId, 'resume');
    if (mounted) _dismissSessionShelf();
  }

  /// ↗ share: open the session's KG view in the browser — the existing
  /// knowledge-share mechanic (opt-out entity list, share links) lives on
  /// the wiki entity page.
  Future<void> _shareBookmark(SessionBookmark b) async {
    final base = context.read<WebSocketService>().httpBase;
    if (base == null) return;
    final uri = Uri.parse('$base${b.kgPath ?? '/knowledge/ui'}');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  /// Call AI over the live session's credited span (sessions list ✦ /
  /// detail-card ▶) — immediately: no brief preview, the handoff fires on
  /// arrival (preview lives on hover instead).
  void _callAiOnActiveSession(SessionChipState s) {
    final ws = context.read<WebSocketService>();
    final minutes =
        ((DateTime.now().millisecondsSinceEpoch - s.startedTs) / 60000)
            .ceil()
            .clamp(1, 120);
    _autoHandoffBrief = true;
    ws.requestSummon(minutes);
  }

  /// ✕ releases the promise; the shelf re-renders without the row.
  Future<void> _removeBookmark(SessionBookmark b) async {
    final ws = context.read<WebSocketService>();
    await ws.sessionBookmarkAction(b.threadId, 'remove');
    if (!mounted) return;
    setState(() => _sessionShelf =
        _sessionShelf?.where((r) => r.threadId != b.threadId).toList());
  }

  /// Hand off from card mode into a full HUD state (e.g. the conversation the
  /// card just seeded). Always lands on the conversation itself — never the
  /// SESSIONS tab (a handoff means "follow the chat", so the tab follows).
  void _leaveCardModeFor(HudState target) {
    if (!_cardMode) {
      if (_state != target) _transitionTo(target);
    } else {
      _cardMode = false;
      _transitionTo(target);
    }
    // AFTER the transition: a handoff means "follow the conversation" — the
    // tab must land on the chat even though a plain uncollapse defaults to
    // the SESSIONS view.
    if (target == HudState.chat) {
      setState(() => _sessionsTab = false);
    }
  }

  /// The stacked capture cards (receipt · enrich · brief · chooser). Rendered
  /// bottom-right of the chat panel, and as the body of the card-mode panel.
  Widget _captureCardsColumn() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        // Session Sense: the running chip is the ambient state; nudge and
        // wrap cards stack above the save cards (violet = session-scoped).
        if (_warmChip != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SessionChip(
              session: _warmChip!,
              others: _sessionChips.length - 1,
              // A click asks for MORE, never ends: expand the detail card.
              onDetails: () {
                setState(() => _assistVisible = !_assistVisible);
                _resizeForCardPanel();
              },
            ),
          ),
        if (_assistVisible && _warmChip != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SessionDetailCard(
              session: _warmChip!,
              assist: _sessionAssists[_warmChip!.sessionId],
              onCallAi: () => _callAiOnActiveSession(_warmChip!),
              onCallSinain: () {
                final s = _warmChip!;
                final minutes =
                    ((DateTime.now().millisecondsSinceEpoch - s.startedTs) /
                            60000)
                        .ceil()
                        .clamp(1, 120);
                unawaited(_callSinain(minutes));
              },
              onSave: () {
                // Save = wrap now: the receipt (with undo) takes the slot;
                // the session stays in the bookmarks list.
                context
                    .read<WebSocketService>()
                    .sessionAction(_warmChip!.sessionId, 'wrapped');
                setState(() => _assistVisible = false);
                _resizeForCardPanel();
              },
              onDismiss: () {
                setState(() => _assistVisible = false);
                _resizeForCardPanel();
              },
            ),
          ),
        if (_sessionShelf != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SessionShelfCard(
              bookmarks: _sessionShelf!,
              onResume: _resumeBookmark,
              onShare: _shareBookmark,
              onRemove: _removeBookmark,
              onDismiss: _dismissSessionShelf,
            ),
          ),
        if (_sessionNudge != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SessionNudgeCard(
              nudge: _sessionNudge!,
              // ▶: resume nudges just resume; fresh nudges track + Call AI.
              onTrack:
                  _sessionNudge!.resume ? _trackSession : _playSessionNudge,
              onCallSinain: _callSinainOnSessionNudge,
              onCorrect: _correctSession,
              onDismiss: _dismissSessionNudge,
            ),
          ),
        if (_sessionWrap != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SessionWrapCard(
              wrap: _sessionWrap!,
              onWrapUp: _wrapSession,
              onLater: _wrapSessionLater,
              onKeepGoing: _keepGoingSession,
              onDismiss: _dismissWrapCard,
            ),
          ),
        // Save offer sits above the receipt: accept clears it and the receipt
        // arrives into the same top slot — one card per save (morph).
        if (_saveOffer != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SaveOfferCard(
              offer: _saveOffer!,
              onAccept: _acceptOffer,
              onAdjust: _adjustOffer,
              onDismiss: _dismissOffer,
            ),
          ),
        if (_saveReceipt != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SaveReceiptCard(
              receipt: _saveReceipt!,
              onUndo: () {
                final id = _saveReceipt!.saveId;
                context.read<WebSocketService>().requestSaveUndo(id);
              },
              onDismiss: () {
                setState(() => _saveReceipt = null);
                _maybeExitCardMode();
              },
            ),
          ),
        if (_activeEnrich != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: EnrichCardWidget(
              card: _activeEnrich!,
              title: _pendingRegion != null
                  ? 'Context from screen'
                  : 'Context from clipboard',
              handoffLabel:
                  'Handoff to ${_handoffAgentLabel(context.read<WebSocketService>())}',
              onDismiss: () {
                setState(() {
                  _activeEnrich = null;
                  _pendingRegion = null;
                });
                _maybeExitCardMode();
              },
              onCallAi: () => _callAiOnEnrich(_activeEnrich!),
              onCopy: () => _copyEnrichCard(_activeEnrich!),
            ),
          ),
        if (_activeBrief != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: BriefCard(
              brief: _activeBrief!,
              dest: _summonDest,
              destLabel: _handoffAgentLabel(context.read<WebSocketService>()),
              onDestChanged: (d) => setState(() => _summonDest = d),
              onDismiss: () {
                setState(() => _activeBrief = null);
                _maybeExitCardMode();
              },
              onAskFollowUp: () => _askFollowUpOnBrief(_activeBrief!),
              onSaveRange: () {
                final minutes = _activeBrief!.minutes;
                setState(() => _activeBrief = null);
                context.read<WebSocketService>().requestSave(minutes);
              },
            ),
          ),
        if (_chooserFor != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: RangeChooser(
              kind: _chooserFor == 'save' ? ChooserKind.save : ChooserKind.call,
              options: _rangeOptions,
              onConfirm: _pickRange,
              defaultMinutes: _offerPrefillMinutes ?? 30,
              preselectedApps:
                  _adjustingOfferId != null ? _offerPrefillApps : null,
              sourcesAt: (m) =>
                  context.read<WebSocketService>().fetchWindowSources(m),
              onConfirmAlt: _chooserFor == 'call'
                  ? (minutes, apps) {
                      setState(() => _chooserFor = null);
                      _callSinain(minutes, apps: apps);
                    }
                  : null,
              previewAt: (m) =>
                  context.read<WebSocketService>().fetchWindowPreview(m),
              onClose: () {
                final adjusting = _adjustingOfferId;
                setState(() => _chooserFor = null);
                if (adjusting != null) {
                  // Cancelling the pre-filled chooser declines the offer.
                  context
                      .read<WebSocketService>()
                      .respondToOffer(adjusting, 'dismissed');
                  _clearAdjustState();
                }
                _maybeExitCardMode();
              },
            ),
          ),
        if (_voiceSession != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: VoiceCallChip(
              session: _voiceSession!,
              onEnd: () => context.read<WebSocketService>().requestVoiceStop(),
              onMute: (muted) =>
                  context.read<WebSocketService>().requestVoiceMute(muted),
              // "Save call": the seeded range + the call itself, through the
              // normal save/undo lifecycle (call audio reaches the feed via
              // system-audio transcription, so the range covers what was said).
              onSaveCall: (minutes) => context
                  .read<WebSocketService>()
                  .requestSave(minutes.clamp(1, 480)),
              onDismiss: () {
                setState(() => _voiceSession = null);
                _maybeExitCardMode();
              },
            ),
          ),
      ],
    );
  }

  /// Card-mode surface: a slim panel with just the capture cards — the whole
  /// HUD stays closed. Clicking the eye glyph or ✕ collapses back to the eye.
  Widget _buildCardPanel() {
    return Align(
      alignment: Alignment.topRight,
      child: GestureDetector(
        // The whole panel is grabbable — a drag on any non-interactive card
        // area moves the window (buttons/slider win the gesture arena for
        // their own taps and drags), so no dedicated drag strip is needed.
        // Each card carries its own ✕; closing the last one exits card mode.
        onPanStart: _onDragStart,
        onPanUpdate: _onDragUpdate,
        behavior: HitTestBehavior.translucent,
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(10),
          child: _captureCardsColumn(),
        ),
      ),
    );
  }

  void _onDragStart(DragStartDetails details) {
    if (_isMacOS) _windowService.beginNativeDrag();
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (_isMacOS) return; // native handles it
    _windowService.moveWindowBy(details.delta.dx, -details.delta.dy);
  }

  void _toggleDemoMode() {
    final nowPrivate = !_settingsService.settings.privacyMode;
    _settingsService.setPrivacyModeTransient(nowPrivate);
    _windowService.setPrivacyMode(nowPrivate);
  }

  void _openSettings() {
    final ws = context.read<WebSocketService>();
    ws.sendCommand('open_settings');
  }

  /// Open the sinain-core knowledge web UI in the user's default browser.
  /// URL is derived from the configured WebSocket URL — swap ws://→http://,
  /// wss://→https://, then append /knowledge/ui. Uses externalApplication
  /// mode so the browser takes focus rather than embedding in a webview.
  Future<void> _openKnowledgeUI() async {
    final ws = _settingsService.settings.wsUrl;
    // Dart's String.replaceFirst doesn't interpret $1 as a capture group —
    // that's replaceFirstMapped. A literal startsWith ladder is clearer
    // anyway and handles all three cases (wss, ws, anything else).
    final String httpUrl;
    if (ws.startsWith('wss://')) {
      httpUrl = 'https://${ws.substring(6)}';
    } else if (ws.startsWith('ws://')) {
      httpUrl = 'http://${ws.substring(5)}';
    } else {
      httpUrl = ws;
    }
    final uri = Uri.parse('$httpUrl/knowledge/ui');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  // ── Feedback prompt ─────────────────────────────────────────────────────────

  /// Open a feedback URL in the user's browser. Mirrors [_openKnowledgeUI].
  Future<void> _openFeedbackUrl(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  /// First value-proof moment of the run: show the one-time prompt if eligible.
  /// Arming counts as an "ask" (capped at [HudSettings.feedbackMaxAsks]) so the
  /// prompt is bounded even when the user keeps ignoring it across restarts.
  void _maybeArmFeedbackPrompt() {
    if (_feedbackEvaluated) return;
    _feedbackEvaluated = true;
    final s = _settingsService.settings;
    if (!s.feedbackEligible(DateTime.now().millisecondsSinceEpoch)) return;
    _settingsService.setFeedbackState(s.feedbackStatus,
        askCount: s.feedbackAskCount + 1);
    if (mounted) setState(() => _feedbackVisible = true);
  }

  /// "Answer the poll" → open the survey, retire the prompt.
  void _feedbackAnswer() {
    _openFeedbackUrl(HudConstants.feedbackSurveyUrl);
    _settingsService.setFeedbackState(FeedbackPromptStatus.retired);
    if (mounted) setState(() => _feedbackVisible = false);
  }

  /// "Later" → snooze; re-arms at the next value-proof after ~3 days.
  void _feedbackLater() {
    final reArm =
        DateTime.now().add(const Duration(days: 3)).millisecondsSinceEpoch;
    _settingsService.setFeedbackState(FeedbackPromptStatus.snoozed,
        snoozeUntilMs: reArm);
    if (mounted) setState(() => _feedbackVisible = false);
  }

  /// "Don't ask again" → retire for good.
  void _feedbackDismiss() {
    _settingsService.setFeedbackState(FeedbackPromptStatus.retired);
    if (mounted) setState(() => _feedbackVisible = false);
  }

  @override
  Widget build(BuildContext context) {
    // Legacy onboarding (connecting → permissions → orientation/hotkeys) is
    // retired — the packaged DMG's first-run wizard handles setup, and macOS
    // requests permissions on demand. This removes the "You're all set / hotkeys"
    // screen that trapped users after the wizard.
    context
        .watch<SettingsService>(); // rebuild on privacy mode change (eye color)
    if (_state == HudState.hidden) {
      return const SizedBox.shrink();
    }

    if (_parked) return _buildAgentIsland();

    // Compact card mode: capture cards without the full HUD (any non-chat
    // state — the chat renders cards in its own Stack).
    if (_cardMode && _state != HudState.chat) {
      return _buildCardPanel();
    }

    switch (_state) {
      case HudState.eye:
        final ws = context.watch<WebSocketService>();
        return Stack(
          children: [
            EyeWidget(
              // Controls/middle mode disabled — tapping the eye opens chat
              // directly (where any pending permission already auto-switched
              // to its tab).
              onTap: () => _transitionTo(HudState.chat),
              // Double-tap the eye → instantly grab a screen region (same flow as
              // the ⊕ tab pill). macOS only — the drag selector is native.
              onDoubleTap: _isMacOS ? _startManualRoi : null,
              onLongPress: () => toggleVisibility(false),
              onSecondaryTap: _isMacOS ? _showEyeContextMenu : null,
              onDragEnd: _onEyeDragEnd,
              pupilDilation: _pupilDilation,
              eyeColor: _eyeColor,
            ),
            if (_unparkedByUser && ws.agentWorking + ws.agentWaiting > 0)
              Positioned(
                top: 3,
                right: 3,
                child: Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    color: _accentColor,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
          ],
        );
      case HudState.controls:
        return _buildControlsBar();
      case HudState.chat:
        return _buildChatPanel();
      case HudState.hidden:
        return const SizedBox.shrink();
    }
  }

  Widget _buildAgentIsland() {
    final ws = context.watch<WebSocketService>();
    final request = _resolvedApproval ?? _nextApproval(ws);
    AgentSession? approvalSession;
    if (request != null) {
      for (final session in ws.agentSessions) {
        if (session.sessionId == request.sessionId) approvalSession = session;
      }
    }
    final bar = SizedBox(
      width: _islandFrameWidthFor(ws, _islandView),
      child: AgentIslandBar(
        working: ws.agentWorking,
        waiting: ws.agentWaiting,
        trackedLabel: _warmChip?.label,
        trackedActiveMs: _warmChip?.activeMs ?? 0,
        saveOfferLabel: _saveOffer?.threadLabel ?? _saveOffer?.coverage,
        enrichLabel: _islandEnrichLabel,
        liveAssist: ws.voiceSession?.isActive ?? false,
        accent: _accentColor,
        notchGap: _notchWidth,
        notchHeight: _notchHeight,
        barHeight: _menuBarHeight,
        onEyeTap: () {
          if (_islandView == _IslandView.bar) {
            _unparkIsland(byUser: true);
          } else {
            _collapseIsland();
          }
        },
        onEyeDragUpdate: _onIslandDragUpdate,
        onEyeDragEnd: _onIslandDragEnd,
        onCountsTap: () {
          if (_islandView == _IslandView.approval) return;
          if (_islandView == _IslandView.bar ||
              (_islandHoverExpanded && !_islandPinned)) {
            _pinIsland();
            _setIslandView(_IslandView.stack);
          } else {
            _collapseIsland();
          }
        },
        onSaveOfferTap: () => _raiseParkedCard(clearEnrich: false),
        onEnrichTap: () => _raiseParkedCard(clearEnrich: true),
        onLiveAssistTap: () => _raiseParkedCard(clearEnrich: false),
      ),
    );
    return MouseRegion(
      onEnter: _onIslandEnter,
      onExit: _onIslandExit,
      child: ColoredBox(
        color: Colors.transparent,
        child: Column(children: [
          Align(alignment: Alignment.topCenter, child: bar),
          if (_islandView == _IslandView.stack)
            Expanded(
              child: Align(
                alignment: Alignment.topCenter,
                child: SizedBox(
                  width: 320,
                  child: Listener(
                    onPointerDown: (_) => _pinIsland(),
                    child: _buildAgentStack(ws),
                  ),
                ),
              ),
            )
          else if (_islandView == _IslandView.approval && request != null)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(0, 8, 0, 0),
                child: Align(
                  alignment: Alignment.topCenter,
                  child: SizedBox(
                    width: 320,
                    child: AgentApprovalCard(
                      request: request,
                      branch: approvalSession?.branch,
                      resolution: _approvalResolution,
                      onDismiss: _resolvedApproval == null
                          ? () {
                              _dismissedApprovals.add(request.id);
                              _setIslandView(_IslandView.bar);
                            }
                          : null,
                      onReply: (behavior) =>
                          _replyToIslandApproval(request, behavior),
                      onReplyWithAnswer: (behavior, {answer}) =>
                          _replyToIslandApproval(
                        request,
                        behavior,
                        answer: answer,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }

  Future<void> _raiseParkedCard({required bool clearEnrich}) async {
    if (clearEnrich) {
      _enrichChipTimer?.cancel();
      setState(() => _islandEnrichLabel = null);
    }
    await _unparkIsland();
    if (!mounted) return;
    _enterCardMode();
  }

  void _scheduleIslandResize() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _parked) _snapIslandToNotch();
    });
  }

  Widget _buildAgentStack(WebSocketService ws) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF1E1F22),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 10, 5),
          child: Row(children: [
            const IdleAnimation(size: 16),
            const SizedBox(width: 6),
            const Text('Agents',
                style: TextStyle(
                    color: Color(0xFFE8EAEE),
                    fontSize: 12,
                    fontWeight: FontWeight.w700)),
            const SizedBox(width: 7),
            Expanded(
                child: Text(
              '${ws.agentWorking} working${ws.agentWaiting > 0 ? ' · ${ws.agentWaiting} waiting' : ''}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontFamily: 'JetBrainsMono',
                  color: Color(0xFFA8ADBD),
                  fontSize: 10),
            )),
            const SizedBox(width: 5),
            if (ws.usage5h != null)
              _islandUsageChip('5h ${ws.usage5h!.round()}%'),
            if (ws.usage7d != null) ...[
              const SizedBox(width: 4),
              _islandUsageChip('7d ${ws.usage7d!.round()}%'),
            ],
          ]),
        ),
        Expanded(
          child: AgentSessionsView(
            showHeader: false,
            showApprovals: false,
            accent: _accentColor,
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 5, 10, 8),
          child: Row(children: [
            Text('${ws.agentSessions.length} sessions',
                style: const TextStyle(
                    fontFamily: 'JetBrainsMono',
                    color: Color(0xFF6C707E),
                    fontSize: 9)),
            const Spacer(),
            Text(ws.connected ? 'bridge ok · :9500' : 'bridge —',
                style: const TextStyle(
                    fontFamily: 'JetBrainsMono',
                    color: Color(0xFF6C707E),
                    fontSize: 9)),
          ]),
        ),
      ]),
    );
  }

  Widget _islandUsageChip(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
        ),
        child: Text(text,
            style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                color: Color(0xFFA8ADBD),
                fontSize: 9)),
      );

  // ── State 2: Controls Bar ──────────────────────────────────────────────────

  Widget _buildControlsBar() {
    final ws = context.watch<WebSocketService>();

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 300 || constraints.maxHeight < 48) {
          return const SizedBox.shrink();
        }
        return GestureDetector(
          onPanStart: _onDragStart,
          onPanUpdate: _onDragUpdate,
          onPanEnd: _isMacOS ? null : (_) => _persistEyePosition(),
          child: Container(
            height: 48,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(24),
            ),
            child: Row(
              children: [
                const SizedBox(width: 8),
                _quitIcon(small: true),
                const SizedBox(width: 4),
                _toggleIcon(
                  icon: ws.screenState == 'active'
                      ? Icons.visibility
                      : Icons.visibility_off,
                  active: ws.screenState == 'active',
                  onTap: () => ws.sendCommand('toggle_screen'),
                  small: true,
                  tooltip: 'Toggle screen capture',
                ),
                _toggleIcon(
                  icon: ws.audioState == 'active'
                      ? Icons.volume_up_rounded
                      : Icons.volume_off_rounded,
                  active: ws.audioState == 'active',
                  onTap: () => ws.sendCommand('toggle_audio'),
                  small: true,
                  tooltip: 'Toggle audio capture',
                ),
                _toggleIcon(
                  icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
                  active: ws.micState == 'active',
                  onTap: () => ws.sendCommand('toggle_mic'),
                  small: true,
                  tooltip: 'Toggle microphone',
                ),
                _toggleIcon(
                  // Both the icon AND its active-tint reflect the combined state:
                  // active only when escalation is running AND at least one agent
                  // is registered. Empty roster → dim, flash_off — signals
                  // "nothing is answering" even if escalation mode isn't explicitly
                  // paused.
                  icon: (ws.escalationState == 'active' &&
                          ws.availableAgents.isNotEmpty)
                      ? Icons.flash_on
                      : Icons.flash_off,
                  active: ws.escalationState == 'active' &&
                      ws.availableAgents.isNotEmpty,
                  onTap: () =>
                      setState(() => _showAgentPicker = !_showAgentPicker),
                  small: true,
                  tooltip: 'Agent selector — which agent handles each lane',
                ),
                const Spacer(),
                // Cost counter (replaces DEMO badge when cost > 0)
                if (ws.totalCost > 0)
                  _costText(ws.totalCost)
                // Demo badge (only when no cost data yet)
                else if (!_settingsService.settings.privacyMode)
                  HudTooltip(
                    message: 'Toggle privacy mode',
                    child: GestureDetector(
                      onTap: _toggleDemoMode,
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 4),
                          // Demo mode (scene 8): a visible red screen — Sinain
                          // is exposed to capture and sees itself.
                          child: Icon(
                            Icons.desktop_windows,
                            size: 13,
                            color: _redEye.withValues(alpha: 0.9),
                          ),
                        ),
                      ),
                    ),
                  ),
                _plainIcon(
                  Icons.psychology_outlined,
                  _openKnowledgeUI,
                  small: true,
                  tooltip: 'Open knowledge browser',
                ),
                _plainIcon(
                  Icons.settings,
                  _openSettings,
                  small: true,
                  tooltip: 'Settings',
                ),
                _plainIcon(
                  Icons.chevron_left,
                  () => _transitionTo(HudState.eye),
                  small: true,
                  tooltip: 'Collapse',
                ),
                _plainIcon(
                  Icons.open_in_full,
                  () => _transitionTo(HudState.chat),
                  small: true,
                  tooltip: 'Expand to chat',
                ),
                const SizedBox(width: 4),
                // Eye animation
                HudTooltip(
                  message: 'Collapse to eye',
                  child: GestureDetector(
                    onTap: () => _transitionTo(HudState.eye),
                    child: Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.black.withValues(alpha: 0.3),
                      ),
                      child: IdleAnimation(
                        size: 32,
                        pupilDilation: _pupilDilation,
                        color: _eyeColor,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
              ],
            ),
          ),
        );
      },
    );
  }

  // ── State 3: Chat Panel ────────────────────────────────────────────────────

  Widget _buildChatPanel() {
    final ws = context.watch<WebSocketService>();

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 300 || constraints.maxHeight < 180) {
          return const SizedBox.shrink();
        }
        return _buildChatPanelContent(ws);
      },
    );
  }

  Widget _buildChatPanelContent(WebSocketService ws) {
    final theme = HudTheme.of(context);
    final chatContent = Container(
      decoration: BoxDecoration(
        color: theme.panelBg,
        borderRadius: BorderRadius.circular(theme.radius),
        border: theme.isSolid ? Border.all(color: theme.border) : null,
        boxShadow: theme.shadow,
      ),
      child: Column(
        children: [
          // Header — draggable, with controls. Right-click opens the same
          // native context menu as the eye (deliberate-capture gestures live
          // there), so the commands stay reachable while the chat is open.
          GestureDetector(
            onPanStart: _onDragStart,
            onPanUpdate: _onDragUpdate,
            onPanEnd: _isMacOS ? null : (_) => _persistEyePosition(),
            onSecondaryTap: _isMacOS ? _showEyeContextMenu : null,
            child: Container(
              height: 40,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              decoration: BoxDecoration(
                color: theme.headerBg,
                borderRadius: BorderRadius.vertical(
                  top: Radius.circular(theme.radius),
                ),
              ),
              child: Row(
                children: [
                  _quitIcon(small: true),
                  const SizedBox(width: 4),
                  // Collapse (controls/middle mode disabled — go to eye)
                  _plainIcon(
                    Icons.expand_more,
                    () => _transitionTo(HudState.eye),
                    small: true,
                    tooltip: 'Collapse to eye',
                  ),
                  const SizedBox(width: 2),
                  // Capture toggles
                  _toggleIcon(
                    icon: ws.screenState == 'active'
                        ? Icons.visibility
                        : Icons.visibility_off,
                    active: ws.screenState == 'active',
                    onTap: () => ws.sendCommand('toggle_screen'),
                    small: true,
                    tooltip: 'Toggle screen capture',
                  ),
                  _toggleIcon(
                    icon: ws.audioState == 'active'
                        ? Icons.volume_up_rounded
                        : Icons.volume_off_rounded,
                    active: ws.audioState == 'active',
                    onTap: () => ws.sendCommand('toggle_audio'),
                    small: true,
                    tooltip: 'Toggle audio capture',
                  ),
                  _toggleIcon(
                    icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
                    active: ws.micState == 'active',
                    onTap: () => ws.sendCommand('toggle_mic'),
                    small: true,
                    tooltip: 'Toggle microphone',
                  ),
                  _toggleIcon(
                    icon: (ws.escalationState == 'active' &&
                            ws.availableAgents.isNotEmpty)
                        ? Icons.flash_on
                        : Icons.flash_off,
                    active: ws.escalationState == 'active' &&
                        ws.availableAgents.isNotEmpty,
                    onTap: () =>
                        setState(() => _showAgentPicker = !_showAgentPicker),
                    small: true,
                    tooltip: 'Agent selector — which agent handles each lane',
                  ),
                  // AGT/TSK tab pill removed — Tasks tab deactivated for
                  // launch (permissions surface via PermissionBanner above
                  // chat input; tasks tab added no unique value).
                  const Spacer(),
                  // Cost counter
                  _costText(ws.totalCost),
                  // Demo toggle (clickable in both states)
                  HudTooltip(
                    message: 'Toggle privacy mode',
                    child: GestureDetector(
                      onTap: _toggleDemoMode,
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          // Scene 8 metaphor: hidden-from-capture = a struck
                          // screen (vision stays clean); demo mode = a visible
                          // screen, turned RED — Sinain sees itself.
                          child: _settingsService.settings.privacyMode
                              ? Icon(
                                  Icons.desktop_access_disabled,
                                  size: 13,
                                  color: Colors.white.withValues(alpha: 0.3),
                                )
                              : Icon(
                                  Icons.desktop_windows,
                                  size: 13,
                                  color: _redEye.withValues(alpha: 0.9),
                                ),
                        ),
                      ),
                    ),
                  ),
                  // Knowledge browser — opens sinain-core's web UI in the
                  // user's default browser. Mirrors the Controls-bar entry.
                  HudTooltip(
                    message: 'Open knowledge browser',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: GestureDetector(
                        onTap: _openKnowledgeUI,
                        behavior: HitTestBehavior.opaque,
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(
                            Icons.psychology_outlined,
                            size: 12,
                            color: Colors.white.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                    ),
                  ),
                  // AI provider — Cerebras / OpenRouter / Local stack switch
                  HudTooltip(
                    message: 'AI provider',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: GestureDetector(
                        onTap: () => setState(
                          () => _showProviderSettings = !_showProviderSettings,
                        ),
                        behavior: HitTestBehavior.opaque,
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(
                            Icons.cloud_sync_outlined,
                            size: 12,
                            color: _showProviderSettings
                                ? _accentColor
                                : Colors.white.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                    ),
                  ),
                  // Settings — tap toggles display panel, long-press opens .env
                  HudTooltip(
                    message: 'Display settings',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: GestureDetector(
                        onTap: () => setState(
                          () => _showDisplaySettings = !_showDisplaySettings,
                        ),
                        onLongPress: _openSettings,
                        behavior: HitTestBehavior.opaque,
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(
                            Icons.settings,
                            size: 12,
                            color: _showDisplaySettings
                                ? _accentColor
                                : Colors.white.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  // Eye — collapses all the way to State 1
                  HudTooltip(
                    message: 'Collapse to eye',
                    child: GestureDetector(
                      onTap: () => _transitionTo(HudState.eye),
                      child: Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: Colors.black.withValues(alpha: 0.3),
                        ),
                        child: IdleAnimation(
                          size: 28,
                          pupilDilation: _pupilDilation,
                          color: _eyeColor,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 2),
                ],
              ),
            ),
          ),
          // Thread tabs — MAIN + one per region conversation (Grammarly
          // mode). Hidden until the first region thread exists.
          _buildThreadTabs(ws),
          // Tab content with display settings overlay. MAIN shows the agent
          // feed; a region tab shows only that ROI's conversation (main
          // escalations do not pour into region threads).
          Expanded(
            child: Stack(
              children: [
                _sessionsTab
                    ? SessionListView(
                        key: const ValueKey('sessions'),
                        ws: ws,
                        accent: _accentColor,
                        onShare: _shareBookmark,
                        onCallAi: _callAiOnActiveSession,
                      )
                    : _terminalThreads.contains(_activeTabKey)
                        ? ThreadTerminalView(
                            key: ValueKey('term-$_activeTabKey'),
                            threadId: _activeTabKey,
                          )
                        : ChatThreadView(
                            key: ValueKey('chat-$_activeTabKey'),
                            ws: ws,
                            threadId: _activeThread,
                            accentColor: _settingsService.settings.accentColor,
                            title: _activeThread == null
                                ? null
                                : _threadTitleFor(ws, _activeThread!),
                            onSend: (text) {
                              final thread = _activeThread;
                              if (thread != null) {
                                _sendToRegionThread(thread, text);
                              } else {
                                ws.sendUserCommand(text);
                              }
                              _syncBusyState();
                            },
                            onHandoff: _handoffThread,
                            onCopySeed: ({required includeTranscript}) {
                              final thread = _activeThread;
                              String? transcript;
                              if (includeTranscript) {
                                final items = thread != null
                                    ? (ws.regionThreads[thread] ??
                                        const <FeedItem>[])
                                    : ws.agentFeedItems;
                                final t = _composeTranscript(items);
                                if (t.isNotEmpty) transcript = t;
                              }
                              return _copySeed(
                                  key: thread ?? 'main',
                                  transcript: transcript);
                            },
                          ),
                if (_showDisplaySettings)
                  DisplaySettingsPanel(
                    onClose: () => setState(() => _showDisplaySettings = false),
                  ),
                if (_showAgentPicker)
                  AgentSelectorPanel(
                    onClose: () => setState(() => _showAgentPicker = false),
                  ),
                if (_showProviderSettings)
                  ProviderSettingsPanel(
                    onClose: () =>
                        setState(() => _showProviderSettings = false),
                  ),
                // Deliberate capture — cards + chooser, bottom-right. The
                // gestures are triggered from the eye's context menu (no
                // dedicated buttons).
                Positioned(
                  right: 10,
                  bottom: 10,
                  child: _captureCardsColumn(),
                ),
              ],
            ),
          ),
          // (The detected-ROI issue/tip + Chat/Term choice now lives in the
          // native suggestion card at the ROI — see RegionEyePool.togglePreview
          // — not in the HUD.)
          // Permission banner — visible above the input field whenever an
          // agent task is blocked waiting for user approval. Hidden (zero
          // height) when no tasks are pending. Mirrors Tasks tab — does not
          // remove tasks from that view.
          const _AgentAvailabilityBanner(),
          const _ServiceHealthBanner(),
          const _SystemAlertBanner(),
          const PermissionBanner(),
          // One-time "Was that helpful?" prompt — armed at the first agent reply
          // (see _maybeArmFeedbackPrompt). Sits with the banner stack above the
          // composer so it reads as Sinain speaking at a natural breakpoint.
          if (_feedbackVisible)
            FeedbackPrompt(
              onAnswer: _feedbackAnswer,
              onLater: _feedbackLater,
              onDismiss: _feedbackDismiss,
            ),
          // Input lives in the chat surface now (flyer composer) — terminal
          // tabs type directly into the PTY. CommandInput retired with the
          // chat-threads redesign (spawn input mode removed with it).
        ],
      ),
    );

    // Wrap in a Stack with resize handles on edges
    return Stack(
      children: [
        chatContent,
        _resizeHandle(
          Alignment.centerLeft,
          SystemMouseCursors.resizeLeft,
          'left',
          (dx, dy) => _windowService.resizeWindowBy(-dx, 0, anchorRight: true),
        ),
        _resizeHandle(
          Alignment.centerRight,
          SystemMouseCursors.resizeRight,
          'right',
          (dx, dy) => _windowService.resizeWindowBy(dx, 0),
        ),
        _resizeHandle(
          Alignment.topCenter,
          SystemMouseCursors.resizeUp,
          'top',
          (dx, dy) => _windowService.resizeWindowBy(0, -dy),
        ),
        _resizeHandle(
          Alignment.bottomCenter,
          SystemMouseCursors.resizeDown,
          'bottom',
          (dx, dy) => _windowService.resizeWindowBy(0, dy, anchorTop: true),
        ),
      ],
    );
  }

  Widget _resizeHandle(
    Alignment alignment,
    MouseCursor cursor,
    String nativeEdge,
    void Function(double dx, double dy) onDragFallback,
  ) {
    final isHorizontal =
        alignment == Alignment.centerLeft || alignment == Alignment.centerRight;
    return Align(
      alignment: alignment,
      child: MouseRegion(
        cursor: cursor,
        child: GestureDetector(
          onPanStart: _isMacOS
              ? (_) => _windowService.beginNativeResize(nativeEdge)
              : null,
          onPanUpdate: _isMacOS
              ? (_) {} // keep alive for gesture arena, native handles tracking
              : (details) {
                  if (details.delta.dx.abs() < 1.0 &&
                      details.delta.dy.abs() < 1.0) {
                    return;
                  }
                  onDragFallback(details.delta.dx, details.delta.dy);
                },
          onPanEnd: _isMacOS ? null : (_) => _persistChatSize(),
          child: Container(
            width: isHorizontal ? 6 : double.infinity,
            height: isHorizontal ? double.infinity : 6,
            color: Colors.transparent,
          ),
        ),
      ),
    );
  }

  Future<void> _persistChatSize() async {
    final frame = await _windowService.getWindowFrame();
    if (frame != null && mounted) {
      _settingsService.setChatSize(frame['w']!, frame['h']!);
    }
  }

  // ── Shared icon helpers ────────────────────────────────────────────────────

  Widget _toggleIcon({
    required IconData icon,
    required bool active,
    required VoidCallback onTap,
    bool small = false,
    String? tooltip,
  }) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(
            icon,
            size: size,
            color: active ? _accentColor : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
    if (tooltip != null) {
      child = HudTooltip(message: tooltip, child: child);
    }
    return child;
  }

  Widget _costText(double cost) {
    if (cost <= 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Text(
        '\$${cost.toStringAsFixed(4)}',
        style: TextStyle(
          fontFamily: 'JetBrainsMono',
          fontSize: 9,
          color: Colors.white.withValues(alpha: 0.35),
        ),
      ),
    );
  }

  Widget _quitIcon({bool small = false}) {
    final dot = small ? 13.0 : 16.0;
    final iconSize = small ? 8.0 : 10.0;
    final pad = small ? 5.0 : 7.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: quitApp,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Container(
            width: dot,
            height: dot,
            decoration: const BoxDecoration(
              color: Color(0xFFFF5F57),
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.close,
              size: iconSize,
              color: Colors.black.withValues(alpha: 0.55),
            ),
          ),
        ),
      ),
    );
    return HudTooltip(message: 'Quit Sinain', child: child);
  }

  Widget _plainIcon(
    IconData icon,
    VoidCallback onTap, {
    bool small = false,
    String? tooltip,
  }) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(
            icon,
            size: size,
            color: Colors.white.withValues(alpha: 0.5),
          ),
        ),
      ),
    );
    if (tooltip != null) {
      child = HudTooltip(message: tooltip, child: child);
    }
    return child;
  }
}

class _AgentAvailabilityBanner extends StatelessWidget {
  const _AgentAvailabilityBanner();

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final text = _warningText(ws);
    if (text == null) return const SizedBox.shrink();
    final showStartButton = _showStartButton(ws);

    const color = Color(0xFFFFAA00);
    return Container(
      height: 38,
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.30)),
      ),
      child: Row(
        children: [
          Icon(Icons.flash_off, size: 13, color: color.withValues(alpha: 0.9)),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: color.withValues(alpha: 0.95),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (showStartButton) ...[
            const SizedBox(width: 6),
            _startButton(ws, color),
          ],
        ],
      ),
    );
  }

  Widget _startButton(WebSocketService ws, Color color) {
    final agent = ws.escalationAgent;
    // Resident chat lane → Run restarts the sidecar; CLI lane → Run launches it.
    final resident = ws.escalationResident;
    final label = resident
        ? 'Start sinain-chat'
        : (agent.isEmpty ? 'Start local agent' : 'Start $agent');
    return HudTooltip(
      message: label,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () {
            if (resident) {
              ws.restartChatSidecar();
              ws.showSystemAlert('Starting sinain-chat…',
                  priority: FeedPriority.high);
            } else {
              ws.startLocalAgent(agent);
              ws.showSystemAlert(
                agent.isEmpty
                    ? 'Starting local escalation agent...'
                    : 'Starting local escalation agent: $agent',
                priority: FeedPriority.high,
              );
            }
          },
          behavior: HitTestBehavior.opaque,
          child: Container(
            width: 26,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: color.withValues(alpha: 0.38)),
            ),
            child: Icon(
              Icons.play_arrow_rounded,
              size: 16,
              color: color.withValues(alpha: 0.95),
            ),
          ),
        ),
      ),
    );
  }

  String? _warningText(WebSocketService ws) {
    if (!ws.connected) return null;
    if (ws.escalationState != 'active') return 'Escalation is paused';
    if (ws.escalationAgent.isEmpty) return 'No chat agent selected';
    // Built-in sinain sidecar: connected only if it's actually reachable.
    if (ws.escalationResident) {
      return ws.chatSidecarUp ? null : 'sinain-chat not running';
    }
    // A CLI chat agent needs bare-agent registration before it can answer.
    if (!ws.agentRegistered) {
      return 'Chat agent not connected: ${ws.escalationAgent}';
    }
    return null;
  }

  bool _showStartButton(WebSocketService ws) {
    if (!ws.connected || ws.escalationState != 'active') return false;
    // Resident lane: show Run only when the sidecar is down (Run restarts it).
    if (ws.escalationResident) return !ws.chatSidecarUp;
    // CLI lane: show Run only for an unstarted agent (Run launches it).
    if (ws.agentRegistered) return false;
    return ws.escalationAgent.isNotEmpty;
  }
}

/// Service guard: warns when a stack service goes stale (running but data is
/// old — e.g. a stuck screen pipeline) or down (expected but unreachable), so a
/// dead service is visible instead of silently feeding stale context.
class _ServiceHealthBanner extends StatelessWidget {
  const _ServiceHealthBanner();

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final stale = ws.staleServices;
    if (stale.isEmpty) return const SizedBox.shrink();
    const color = Color(0xFFFFAA00);
    final msg = stale.map((s) {
      final label = (s['label'] ?? s['name'] ?? 'service').toString();
      final down = s['state'] == 'down';
      final detail = s['detail'];
      return down
          ? '$label down'
          : '$label stale${detail != null ? ' ($detail)' : ''}';
    }).join(' · ');

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.38)),
      ),
      child: Row(
        children: [
          const Icon(Icons.sensors_off, size: 14, color: color),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              '$msg — context may be outdated',
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: color,
                height: 1.2,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _SystemAlertBanner extends StatelessWidget {
  const _SystemAlertBanner();

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final text = ws.systemAlertText;
    if (text == null || text.isEmpty) return const SizedBox.shrink();

    final urgent = ws.systemAlertPriority == FeedPriority.urgent;
    final color = urgent ? const Color(0xFFFF3344) : const Color(0xFFFFAA00);

    return Container(
      height: 44,
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.38)),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, size: 14, color: color),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: color,
                height: 1.2,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          HudTooltip(
            message: 'Dismiss',
            child: GestureDetector(
              onTap: ws.clearSystemAlert,
              behavior: HitTestBehavior.opaque,
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Padding(
                  padding: const EdgeInsets.all(3),
                  child: Icon(
                    Icons.close,
                    size: 12,
                    color: color.withValues(alpha: 0.75),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
