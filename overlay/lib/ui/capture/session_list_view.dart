import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/models/context_cards.dart';
import '../../core/services/websocket_service.dart';
import '../../core/theme/hud_theme.dart';

const _green = Color(0xFF1F8039);
const _amber = Color(0xFFD9A21B);

TextStyle _mono(double size, Color color,
        {FontWeight weight = FontWeight.w400, double? height}) =>
    TextStyle(
      fontFamily: HudConstants.monoFont,
      fontSize: size,
      color: color,
      fontWeight: weight,
      height: height,
    );

/// The sessions view — the HUD's primary uncollapsed content (product call
/// 2026-07-16: the list replaces the main chat as what you see first).
///
/// TRACKING NOW: the live session (label · elapsed · paused), with ⚑ flag,
/// Call AI, and End. BOOKMARKED (§9): the ⚑ shelf — ▶ resume, ↗ share
/// (KG view), ✕ release. Hydrates from GET /capture/session/bookmarks, then
/// rides the chip stream.
class SessionListView extends StatefulWidget {
  final WebSocketService ws;

  /// ↗ share — the shell owns URL launching (KG entity page).
  final ValueChanged<SessionBookmark> onShare;

  /// Call AI over the live session's span (shell owns the summon flow).
  final ValueChanged<SessionChipState> onCallAi;

  const SessionListView({
    super.key,
    required this.ws,
    required this.onShare,
    required this.onCallAi,
  });

  /// Hover-preview span cap (matches the summon clamp).
  static const int maxPreviewMinutes = 120;

  @override
  State<SessionListView> createState() => _SessionListViewState();
}

class _SessionListViewState extends State<SessionListView> {
  SessionList _list = const SessionList(active: null, bookmarks: []);
  StreamSubscription<SessionChipState>? _chipSub;
  Timer? _ticker;
  DateTime _activeReceivedAt = DateTime.now();
  bool _loaded = false;
  // Hover preview of the context the ✦ call would carry (cached core-side).
  String? _preview;
  bool _previewLoading = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    _chipSub = widget.ws.sessionChipStream.listen((c) {
      if (!mounted) return;
      setState(() {
        _activeReceivedAt = DateTime.now();
        _list = SessionList(
          active: c.ended ? null : c,
          bookmarks: _list.bookmarks,
        );
      });
      // A wrap may have updated bookmark history — refetch quietly.
      if (c.ended) _refresh();
      _syncTicker();
    });
    _syncTicker();
  }

  Future<void> _refresh() async {
    final list = await widget.ws.fetchSessionList();
    if (!mounted) return;
    setState(() {
      _list = list;
      _activeReceivedAt = DateTime.now();
      _loaded = true;
    });
    _syncTicker();
  }

  void _syncTicker() {
    _ticker?.cancel();
    if (_list.active != null && !_list.active!.paused) {
      _ticker =
          Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    }
  }

  @override
  void dispose() {
    _chipSub?.cancel();
    _ticker?.cancel();
    super.dispose();
  }

  String _elapsed(SessionChipState s) {
    var ms = s.activeMs;
    if (!s.paused) {
      ms += DateTime.now().difference(_activeReceivedAt).inMilliseconds;
    }
    final sec = ms ~/ 1000;
    return '${sec ~/ 60}:${(sec % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final active = _list.active;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('TRACKING NOW',
              style: _mono(9, t.textDim, weight: FontWeight.w600)),
          const SizedBox(height: 6),
          if (active == null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                  _loaded
                      ? 'nothing tracked — work a few minutes and Sinain will ask'
                      : ' ',
                  style: _mono(10, t.textDim)),
            )
          else ...[
            _activeRow(t, active),
            // The context preview the ✦ call would carry — on hover only.
            if (_preview != null)
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Text(_preview!,
                    style: _mono(9, t.textDim, height: 1.35),
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis),
              ),
          ],
          const SizedBox(height: 14),
          Row(children: [
            Text('BOOKMARKED',
                style: _mono(9, t.textDim, weight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('${_list.bookmarks.length}', style: _mono(9, t.textDim)),
          ]),
          const SizedBox(height: 6),
          if (_list.bookmarks.isEmpty)
            Text(
                _loaded
                    ? 'nothing flagged — "⚑ Later" on a wrap card lands here'
                    : ' ',
                style: _mono(10, t.textDim))
          else
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (final b in _list.bookmarks) _bookmarkRow(t, b),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _activeRow(HudTheme t, SessionChipState s) {
    final dot = s.paused ? _amber : _green;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(color: dot.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: dot,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(color: dot.withValues(alpha: 0.3), spreadRadius: 2),
            ],
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Text(s.label,
              style: _mono(11, t.textPrimary, weight: FontWeight.w500),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ),
        Text(_elapsed(s), style: _mono(10, s.paused ? _amber : t.textMuted)),
        if (s.paused) ...[
          const SizedBox(width: 6),
          Text('paused', style: _mono(9, _amber)),
        ],
        const SizedBox(width: 8),
        MouseRegion(
          onEnter: (_) => _loadPreview(s),
          onExit: (_) => setState(() => _preview = null),
          child:
              _action(t, '✦', 'Call AI on this session', () => widget.onCallAi(s)),
        ),
        const SizedBox(width: 5),
        _action(t, '⚑', 'Come back later (bookmark)', () async {
          await widget.ws.sessionAction(s.sessionId, 'flag');
          _refresh();
        }),
        const SizedBox(width: 5),
        _action(t, '✕', 'End session', () {
          widget.ws.sessionAction(s.sessionId, 'ended');
        }),
      ]),
    );
  }

  /// Fetch the (core-cached) window preview for the session's span — shown
  /// under the row while hovering ✦, so the call is one click but never blind.
  Future<void> _loadPreview(SessionChipState s) async {
    if (_previewLoading) return;
    _previewLoading = true;
    try {
      final minutes =
          ((DateTime.now().millisecondsSinceEpoch - s.startedTs) / 60000)
              .ceil()
              .clamp(1, SessionListView.maxPreviewMinutes);
      final data = await widget.ws.fetchWindowPreview(minutes);
      if (!mounted) return;
      final summary = data?['summary'] as String?;
      if (summary != null && summary.isNotEmpty) {
        setState(() => _preview = summary);
      }
    } finally {
      _previewLoading = false;
    }
  }

  Widget _bookmarkRow(HudTheme t, SessionBookmark b) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Text('⚑ ', style: _mono(11, _green)),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(b.label,
                  style: _mono(11, t.textPrimary, weight: FontWeight.w500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
              Text(b.meta, style: _mono(9, t.textDim)),
            ],
          ),
        ),
        _action(t, '▶', 'Resume', () async {
          await widget.ws.sessionBookmarkAction(b.threadId, 'resume');
          _refresh();
        }, accent: _green),
        const SizedBox(width: 5),
        _action(t, '↗', 'Share session (KG view)', () => widget.onShare(b)),
        const SizedBox(width: 5),
        _action(t, '✕', 'Release', () async {
          await widget.ws.sessionBookmarkAction(b.threadId, 'remove');
          _refresh();
        }),
      ]),
    );
  }

  Widget _action(HudTheme t, String glyph, String tooltip, VoidCallback onTap,
      {Color? accent}) {
    return Tooltip(
      message: tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border:
                  Border.all(color: accent?.withValues(alpha: 0.5) ?? t.border),
            ),
            child: Text(glyph, style: _mono(9, accent ?? t.textMuted)),
          ),
        ),
      ),
    );
  }
}
