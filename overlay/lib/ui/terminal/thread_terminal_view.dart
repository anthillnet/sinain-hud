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
/// Shipped feature since overlay 2.13.x — the spike gate (kDebugMode ||
/// SINAIN_TERMINAL_SPIKE) made the chat⇄term toggle invisible in every
/// release build, so production users never saw the terminal at all.
const bool terminalSpikeEnabled = true;

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

  /// Locate sinain-agent-runner/run.sh: DMG bundle Resources first, then explicit
  /// env override, then dev-repo locations. Null → caller falls back to a
  /// plain shell.
  static String? findRunSh() {
    final exeDir = File(Platform.resolvedExecutable).parent; // Contents/MacOS
    final candidates = [
      '${exeDir.parent.path}/Resources/sinain-agent-runner/run.sh',
      Platform.environment['SINAIN_AGENT_RUNSH'] ?? '',
      '${Directory.current.path}/sinain-agent-runner/run.sh',
      '${Directory.current.parent.path}/sinain-agent-runner/run.sh',
    ];
    for (final c in candidates) {
      if (c.isNotEmpty && File(c).existsSync()) return c;
    }
    // Dev builds: the debug .app lives deep under <repo>/overlay/build/...,
    // and `open`-launched apps have cwd=/ — so walk up from the executable
    // (and the cwd) looking for sinain-agent-runner/run.sh. Self-correcting at any
    // build depth, so no manual SINAIN_AGENT_RUNSH is needed in dev.
    for (final start in [exeDir, Directory.current]) {
      Directory dir = start;
      for (var i = 0; i < 12; i++) {
        final candidate = '${dir.path}/sinain-agent-runner/run.sh';
        if (File(candidate).existsSync()) return candidate;
        final parent = dir.parent;
        if (parent.path == dir.path) break; // filesystem root
        dir = parent;
      }
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

    // A distinctive token from the seed path (the random mcp temp-dir name)
    // — if it shows up on screen after we type, our text landed; if not, it
    // was eaten (e.g. by a trust dialog that appeared late) and we retry.
    var seedDone = false;
    var attemptInFlight = false;
    var attempts = 0;
    var lastOutputAt = DateTime.now();

    void attemptSeed() {
      if (seedDone || seedTyped || attemptInFlight || session.exited) return;
      final scr = currentScreen();
      if (modalNeedles.any((r) => r.hasMatch(scr))) {
        // A modal owns the keyboard — wait for it to clear (user answers, or
        // it auto-dismisses). Reading the live buffer means this stops the
        // moment the dialog is gone.
        if (kDebugMode) print('[seed] modal on screen — retry 1.5s');
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 1500), attemptSeed);
        return;
      }
      final quietFor = DateTime.now().difference(lastOutputAt).inMilliseconds;
      if (quietFor < 800) {
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 900), attemptSeed);
        return;
      }
      if (attempts >= 5) {
        if (kDebugMode) print('[seed] gave up after $attempts attempts');
        seedTyped = true; // stop trying
        return;
      }
      attempts++;
      attemptInFlight = true;
      settle?.cancel();
      // Probe must be unique to our TYPED text — NOT the seed path, which is
      // also in run.sh's ⟦SINAIN-SEED:…⟧ marker line (still in the buffer),
      // or every verify falsely "confirms". This phrase appears only in the
      // message we type (in the input box, or echoed in the transcript once
      // submitted), never in the marker.
      const pointer = 'and follow its instructions.';
      const probe = 'follow its instructions';
      if (kDebugMode) print('[seed] attempt $attempts — typing pointer');
      pty.write(const Utf8Encoder().convert('Read $seedFile $pointer'));
      Timer(const Duration(milliseconds: 400), () {
        if (!session.exited) pty.write(const Utf8Encoder().convert('\r'));
      });
      // Verify: did our typed text reach the screen? If not, the keystrokes
      // were eaten — retry (a late dialog will now be visible and waited out).
      Timer(const Duration(milliseconds: 2500), () {
        attemptInFlight = false;
        if (seedDone || session.exited) return;
        if (currentScreen().contains(probe)) {
          seedDone = true;
          seedTyped = true;
          cap?.cancel();
          if (kDebugMode) print('[seed] confirmed on screen ✓');
        } else {
          if (kDebugMode) print('[seed] not on screen — re-attempt');
          attemptSeed();
        }
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
        if (seedDone || seedTyped) return;
        settle?.cancel();
        settle = Timer(const Duration(milliseconds: 800), attemptSeed);
        return;
      }
      carry += data;
      final m = seedMarker.firstMatch(carry);
      if (m != null) {
        seedFile = m.group(1)!;
        if (kDebugMode) print('[seed] marker seen → $seedFile');
        carry = '';
        // Do NOT arm settle here. run.sh prints the marker just before
        // exec'ing the agent, so the agent hasn't drawn anything yet — a
        // timer started now fires into an empty screen and types before the
        // TUI (and its trust dialog) exists. The agent's OWN output (next
        // chunks, seedFile.isNotEmpty branch) arms settle, so the screen
        // buffer always has real content when attemptSeed checks it. cap
        // is a long safety net for an agent that somehow emits nothing.
        cap = Timer(const Duration(seconds: 12), attemptSeed);
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
