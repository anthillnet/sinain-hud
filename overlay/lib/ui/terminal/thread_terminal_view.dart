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
  ThreadTerminalSession._(this.terminal, this.controller, this._pty);

  final Terminal terminal;
  final TerminalController controller;
  final Pty _pty;
  bool exited = false;

  static final Map<String, ThreadTerminalSession> _sessions = {};

  static ThreadTerminalSession of(String threadId) =>
      _sessions.putIfAbsent(threadId, () => _spawn(threadId));

  static ThreadTerminalSession _spawn(String threadId) {
    final terminal = Terminal(maxLines: 10000);
    final controller = TerminalController();
    final shell = Platform.environment['SHELL'] ?? '/bin/zsh';
    final pty = Pty.start(
      shell,
      arguments: ['-il'], // interactive login — same env the user's terminal has
      columns: terminal.viewWidth,
      rows: terminal.viewHeight,
      workingDirectory: Platform.environment['HOME'],
      environment: {
        ...Platform.environment,
        'TERM': 'xterm-256color',
        'SINAIN_THREAD': threadId,
      },
    );
    final session = ThreadTerminalSession._(terminal, controller, pty);

    pty.output
        .cast<List<int>>()
        .transform(const Utf8Decoder(allowMalformed: true))
        .listen(terminal.write);
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
