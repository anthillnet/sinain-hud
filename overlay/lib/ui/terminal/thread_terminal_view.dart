import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_pty/flutter_pty.dart';
import 'package:xterm/xterm.dart';

/// SPIKE (thread terminal): full terminal emulator inside a thread tab.
///
/// Gate: debug builds, or SINAIN_TERMINAL_SPIKE=true in the app's
/// environment. Release UX is unchanged until the spike graduates.
///
/// What this validates (the open questions from the OSS research):
///   1. keyboard focus + key routing inside the non-activating NSPanel
///   2. IME and copy/paste quality (xterm uses TextInput, not raw keys)
///   3. render quality/perf of the CustomPaint terminal over the
///      translucent HUD background
///
/// Pure Flutter (xterm) + native PTY (flutter_pty) — renders inside the
/// existing private panel, so capture-invisibility is inherited.
bool get terminalSpikeEnabled =>
    kDebugMode || Platform.environment['SINAIN_TERMINAL_SPIKE'] == 'true';

/// One live shell session: emulator state + PTY. Cached per thread so the
/// process survives tab switches — only an explicit close kills it.
class ThreadTerminalSession {
  ThreadTerminalSession._(
      this.terminal, this.controller, this._pty, this.command, this.args);

  final Terminal terminal;
  final TerminalController controller;
  final Pty _pty;
  // Launch spec, kept so an exited session respawns the same way even when
  // the caller (e.g. a widget rebuild) doesn't pass it again.
  final String? command;
  final List<String>? args;
  bool exited = false;

  static final Map<String, ThreadTerminalSession> _sessions = {};

  /// Get (or spawn) the session for a thread. [command]/[args] only apply
  /// when the session doesn't exist yet — default is the user's login shell.
  /// A session whose process has exited is dropped and respawned fresh.
  static ThreadTerminalSession of(String threadId,
      {String? command, List<String>? args, String? banner}) {
    final cached = _sessions[threadId];
    if (cached != null && !cached.exited) return cached;
    final session = _spawn(
      threadId,
      command: command ?? cached?.command,
      args: args ?? cached?.args,
      banner: banner,
    );
    _sessions[threadId] = session;
    return session;
  }

  /// Locate sinain-agent/run.sh: DMG bundle Resources first, then explicit
  /// env override, then dev-repo locations relative to the cwd flutter run
  /// started from. Null → caller falls back to a plain shell.
  static String? findRunSh() {
    final exeDir = File(Platform.resolvedExecutable).parent; // Contents/MacOS
    final candidates = [
      '${exeDir.parent.path}/Resources/sinain-agent/run.sh',
      Platform.environment['SINAIN_AGENT_RUNSH'] ?? '',
      '${Directory.current.path}/sinain-agent/run.sh',
      '${Directory.current.parent.path}/sinain-agent/run.sh',
    ];
    for (final c in candidates) {
      if (c.isNotEmpty && File(c).existsSync()) return c;
    }
    return null;
  }

  static ThreadTerminalSession _spawn(String threadId,
      {String? command, List<String>? args, String? banner}) {
    final terminal = Terminal(maxLines: 10000);
    final controller = TerminalController();
    if (banner != null) terminal.write('\x1b[33m$banner\x1b[0m\r\n');
    final shell = Platform.environment['SHELL'] ?? '/bin/zsh';
    // Strip Claude-session vars before spawning: when the overlay itself was
    // launched from a Claude Code shell (dev: flutter run), CLAUDE_CONFIG_DIR
    // & co. leak into Platform.environment and break agent auth in the
    // terminal (401 "No cookie auth credentials"). Mirrors the strip in
    // sinain-core startLocalAgent; profile-level overrides are reapplied by
    // run.sh's apply_profile_env afterwards.
    final env = {
      for (final e in Platform.environment.entries)
        if (!e.key.startsWith('CLAUDE_CODE_') &&
            e.key != 'CLAUDE_CONFIG_DIR' &&
            e.key != 'CLAUDECODE' &&
            e.key != 'AI_AGENT')
          e.key: e.value,
      'TERM': 'xterm-256color',
      'SINAIN_THREAD': threadId,
    };
    final pty = Pty.start(
      command ?? shell,
      // default: interactive login — same env the user's terminal has
      arguments: args ?? ['-il'],
      columns: terminal.viewWidth,
      rows: terminal.viewHeight,
      workingDirectory: Platform.environment['HOME'],
      environment: env,
    );
    final session =
        ThreadTerminalSession._(terminal, controller, pty, command, args);

    // Some agent TUIs (claude, openclaude, hermes) accept no seed prompt via
    // CLI — run.sh writes the context to a file and emits ⟦SINAIN-SEED:<p>⟧;
    // we type a pointer message into the TUI once it's ready. "Ready" =
    // output quiescent for 800ms after the marker (the TUI finished its
    // initial render — typing earlier risks the raw-mode init flushing the
    // TTY input queue), with a 6s hard cap for TUIs that keep animating.
    var seedFile = '';
    var seedTyped = false;
    var carry = '';
    Timer? settle;
    Timer? cap;
    final seedMarker = RegExp('⟦SINAIN-SEED:([^⟧]+)⟧');
    // Startup modals (claude's folder-trust check, theme pickers) own the
    // keyboard — typing into them answers the dialog and the seed is lost.
    // We read the ACTUAL rendered screen from xterm's buffer (not raw bytes:
    // claude redraws by overwriting lines with cursor moves, so a hand-rolled
    // byte buffer would keep stale dialog text forever). The buffer already
    // reflects overwrites, so a dismissed dialog's text is gone. Words are
    // space-separated there, so match normal phrases case-insensitively.
    final modalNeedles = [
      RegExp(r'trust\s+this\s+folder', caseSensitive: false),
      RegExp(r'do you trust', caseSensitive: false),
      RegExp(r'esc to cancel', caseSensitive: false),
      RegExp(r'enter to confirm', caseSensitive: false),
    ];

    String currentScreen() {
      try {
        return terminal.buffer.getText();
      } catch (_) {
        return '';
      }
    }

    var lastOutputAt = DateTime.now();
    void maybeTypeSeed() {
      if (seedTyped || session.exited) return;
      final scr = currentScreen();
      final hit = modalNeedles.where((r) => r.hasMatch(scr)).toList();
      if (hit.isNotEmpty) {
        // A modal owns the keyboard — wait for the user to answer it. We read
        // the live screen each tick, so this stops matching the moment the
        // dialog is gone.
        if (kDebugMode) print('[seed] modal on screen — retry 1.5s');
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 1500), maybeTypeSeed);
        return;
      }
      // Never type mid-redraw — require output quiet for 800ms first, so the
      // input box exists and raw-mode init won't flush the bytes.
      final quietFor = DateTime.now().difference(lastOutputAt).inMilliseconds;
      if (quietFor < 800) {
        if (kDebugMode) print('[seed] still redrawing (${quietFor}ms) — wait');
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 900), maybeTypeSeed);
        return;
      }
      seedTyped = true;
      settle?.cancel();
      cap?.cancel();
      if (kDebugMode) print('[seed] typing pointer for $seedFile');
      // Text first, Enter separately — a single chunk can trip the TUI's
      // paste heuristics (observed: openclaude submitting AND leaving a
      // duplicate copy in the input field).
      pty.write(const Utf8Encoder()
          .convert('Read $seedFile and follow its instructions.'));
      Timer(const Duration(milliseconds: 400), () {
        if (!session.exited) pty.write(const Utf8Encoder().convert('\r'));
      });
    }

    pty.output
        .cast<List<int>>()
        .transform(const Utf8Decoder(allowMalformed: true))
        .listen((data) {
      terminal.write(data);
      if (seedTyped) return;
      lastOutputAt = DateTime.now();
      if (seedFile.isNotEmpty) {
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 800), maybeTypeSeed);
        return;
      }
      carry += data;
      final m = seedMarker.firstMatch(carry);
      if (m != null) {
        seedFile = m.group(1)!;
        if (kDebugMode) print('[seed] marker seen → $seedFile');
        carry = '';
        settle = Timer(const Duration(milliseconds: 800), maybeTypeSeed);
        cap = Timer(const Duration(seconds: 6), maybeTypeSeed);
      } else if (carry.length > 4096) {
        carry = carry.substring(carry.length - 256);
      }
    });
    pty.exitCode.then((code) {
      session.exited = true;
      terminal.write('\r\n\x1b[90m[shell exited ($code) — close and reopen '
          'the terminal tab to restart]\x1b[0m\r\n');
    });
    terminal.onOutput = (data) => pty.write(const Utf8Encoder().convert(data));
    terminal.onResize = (w, h, pw, ph) => pty.resize(h, w);
    return session;
  }

  /// Kill the PTY and drop the cached session (thread tab closed).
  static void close(String threadId) {
    final s = _sessions.remove(threadId);
    if (s != null && !s.exited) s._pty.kill();
  }
}

class ThreadTerminalView extends StatelessWidget {
  const ThreadTerminalView({super.key, required this.threadId});

  final String threadId;

  @override
  Widget build(BuildContext context) {
    final session = ThreadTerminalSession.of(threadId);
    return TerminalView(
      session.terminal,
      controller: session.controller,
      autofocus: true,
      padding: const EdgeInsets.all(6),
      textStyle: const TerminalStyle(fontSize: 11),
      backgroundOpacity: 0.6, // let the HUD translucency show through
    );
  }
}
