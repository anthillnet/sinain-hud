# Handoff: chat-threads redesign (2026-06-11)

Working branch: **`feat/chat-threads`** (includes `feat/region-tuning`, whose
PR **#148 is still open** — merge it first, then this branch's eventual PR
shrinks to the chat work). Delete this file before the final merge.

## The model (Igor-approved)

- Everything is a **thread** = one persistent agent session, drivable as
  **chat or terminal** (💬/⌨ toggle, pinned right of the tab row). MAIN is
  the always-on thread; ambient escalations post into it **only while the
  user is idle** (any chat/terminal interaction opens a quiet window;
  explicit IDLE MESSAGES switch in the agent selector).
- **No autonomous spawns, ever.** Agents answer inline. Only the user opens
  threads (ROI banner: **[💬 Chat] [⌨ Term]**) — and later, forks MAIN (P5).
- Lanes relabeled in UI: **CHAT** (wire: `escalation`) answers MAIN/ambient;
  **TERM** (wire: `spawn`) runs threads/terminals.
- Raw stream (transcripts/OCR) has **no UI surface** — internal context only.

## Done (all pushed, running on Igor's machine)

- **P1**: flyer `flutter_chat_ui` 2.11 renders all chat tabs
  (`overlay/lib/ui/chat/chat_thread_view.dart`); CommandInput retired;
  idle-eye empty state; black composer; Enter sends / Shift+Enter newline;
  SelectionArea copy; "sinain is thinking…" strip (MAIN).
- **P2**: per-thread sessions. Core allocates the uuid
  (`escalator.threadSession()`); agent gets `--session-id` (first) /
  `--resume` (later). Rides spawn pending payload + `GET /region/:id/task`.
  **Thread invocations `cd $HOME`** — claude sessions are per-cwd and the
  terminal PTY lives in $HOME.
- **P3**: surface exclusivity — term→chat closes the PTY (overlay_shell pill
  onTap); session persists on disk; ⌨ re-resumes with history.
- **P4 (core part)**: autonomous spawns closed at 3 layers — `POST /spawn`
  → 410, `sinain_spawn` removed from sinain-mcp-server, sinain-agent/CLAUDE.md
  rewritten ("answer inline").
- **Conversational contract**: user message supersedes in-flight AMBIENT
  escalation (late response dropped in `respondHttp`); urgent ticks bypass
  ALL idle-skips in `loop.ts` (user messages can't be silently dropped).
- **Loop resilience**: tick errors restore buffer-version cursors (60s
  interval retries); outage → one "⚠ Network issue…" feed notice, recovery
  → "✓ Connectivity restored".
- Region-tuning (PR #148): line-level eye anchoring (ocr_lines end-to-end),
  24px eyes, app-scoped rotation, fuzzy re-detection, expire-before-admit,
  no-TTL context archive, live-set region prompt, async knowledge query
  (was a 10s sync event-loop freeze), knowledge-enriched seeds (1.5s budget).

## Open items (priority order)

1. **Merge PR #148**, then rebase/clean this branch.
2. **P4 finish**: replace spawn wire vocabulary with a thread protocol —
   `SpawnTaskMessage`/`spawn_command`/status chips are still the *transport*
   for thread messages (sender=spawn → rendered as user, queue-noise
   suppressed — both are filters that a real `thread_message` type removes).
   Keep `/spawn/ask` (interactive agent question) + PreToolUse permissions.
3. **P5**: fork MAIN → new thread (`--fork-session` for claude-likes;
   transcript-seed fallback). MAIN itself has no session yet (`--interactive-main`
   seeds from digest each time) — decide whether MAIN gets a session too.
4. **CLAUDE.md regression**: thread invocations `cd $HOME`, so
   `sinain-agent/CLAUDE.md` no longer auto-loads. Fold its essentials into
   the seed or `--append-system-prompt`.
5. **sense_client timeout audit**: it hung for 2.5h in a network call during
   a DNS outage (process alive, no events). Every requests/vision call needs
   a timeout; consider a watchdog.
6. Optional: per-message copy button on hover (SelectionArea covers most).
7. Release when stable: bump RELEASE_VERSIONS.json (merge-driven; see
   docs/RELEASING.md). Last shipped: dmg 0.3.3/overlay 2.13.2/npm 1.27.2.

## Gotchas (hard-won)

- **openclaude/claude TUIs ignore CLI seeds** (positional AND
  --append-system-prompt) → seeds are *typed* into the TUI by the overlay
  (`⟦SINAIN-SEED:<file>⟧` marker protocol in run.sh + thread_terminal_view;
  verify-and-retry, modal-aware via xterm's screen buffer, quiescence-gated).
- **claude sessions are per-cwd**; trust dialogs appear per-dir (first run).
- bash 3.2: `${arr[@]+"${arr[@]}"}` for empty arrays; `${VAR}` before
  multibyte chars; BSD mktemp needs trailing Xs.
- run.sh loads `~/.sinain/.env` as fallback (direct invocations need it).
- Strip `CLAUDE_CODE_*`/`CLAUDE_CONFIG_DIR`/`CLAUDECODE`/`AI_AGENT` from any
  spawned agent env (PTY does, startLocalAgent does).
- The openclaude lane fails with OpenRouter 402 when credits run out — the
  drop-backoff abandons after 3 and posts a feed warning (by design).

## Dev loop

```bash
./start.sh --no-overlay                                  # backend (LOG_LEVEL=debug for raw LLM dumps)
cd overlay && SINAIN_AGENT_RUNSH=$PWD/../sinain-agent/run.sh flutter run -d macos --debug
# fake ROI for testing:
curl -s -X POST localhost:9500/sense -H 'Content-Type: application/json' -d \
 '{"type":"text","ts":0,"ocr":"FAILED tests/x.py - AssertionError","roi":{"bbox":[400,400,500,60],"frame_size":[1440,900]},"ocr_lines":[{"text":"FAILED tests/x.py - AssertionError","bbox":[410,410,480,22]}],"meta":{"ssim":0.5,"app":"Terminal","screen":0}}'
# debug terminal seeding without UI:
SINAIN_TERM_DRYRUN=1 bash sinain-agent/run.sh --interactive-main
```

Igor's rules: never push to a PR branch after announcing it; ROI context must
stay valid as long as it's clickable; no plumbing noise in chats.
