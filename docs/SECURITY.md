# Security — On-Device User Data

SinainHUD processes highly sensitive context locally: screen OCR, audio transcripts,
a knowledge graph distilled from your activity, and live screenshots. This document
describes how that data is protected **at rest on disk** and the threat model we design
against.

## Threat model

These are unsandboxed local processes running as your user. The realistic risks to
on-device data are:

- **Other apps running as the same user** — any process you run can read your home dir.
- **Backup / cloud sync** silently replicating plaintext (Time Machine, iCloud Desktop,
  Dropbox) — file permissions ride along into the backup.
- **Other local accounts** on a shared/multi-user machine (world/group-readable bits).
- **Device theft** without full-disk encryption.
- **Forensic / deleted-file recovery.**

Full-disk encryption (FileVault / BitLocker) covers device theft but **not** same-user
apps or cloud sync — so OS-level FDE is necessary but not sufficient.

## Where on-device data lives

| Path | Contents |
|------|----------|
| `~/.sinain/memory/` | Knowledge graph (RocksDB + SQLite), distilled daily notes, raw transcript+embedding store, pending session |
| `~/.sinain/capture/frame.jpg` | The current screen frame (overwritten ~1/s; in-memory OCR thereafter) |
| `~/.sinain/.env`, `~/.sinain/sinain-core/.env` | `OPENROUTER_API_KEY` and gateway tokens |
| `~/.sinain/agents.json`, `auth-profiles.json`, `device-identity.json` | Agent/gateway config + device key |
| `~/.sinain-core/feedback/`, `~/.sinain-core/traces/` | Escalation feedback + analysis traces |
| `~/.openclaw/workspace/SITUATION.md` | Rich current-context snapshot (OCR + transcripts + digest) |
| `backend.log` (dev) | Piped service stdout — may contain OCR/vision/transcript lines |

## Protections in place

### Filesystem permissions (owner-only)

Every Sinain process sets a restrictive **umask of `0o077`** at startup, so all files it
(and its children) create are `0600` and all directories `0700` — never world/group
readable:

- `sinain-core/src/index.ts` — `process.umask(0o077)`
- `sinain-hud-plugin/launcher.js` — `process.umask(0o077)`
- `sense_client/__main__.py` — `os.umask(0o077)` (POSIX)
- `tools/sck-capture/main.swift` — `umask(0o077)` + capture dir created `0700`
- `start.sh` — `umask 077`

On startup, `sinain-core` also runs `hardenLocalDataPermissions()`
(`sinain-core/src/util/harden-permissions.ts`), a best-effort pass that tightens data
left world-readable by **older** builds: container dirs → `0700`, data files → `0600`,
and known-sensitive files (`.env`, `agents.json`, `auth-profiles.json`,
`device-identity.json`, `SITUATION.md`) → `0600`.

Config writers set modes explicitly too: `.env` and `agents.json` are written `0600`
(`config-shared.js`, `setup-local.sh`).

### Privacy stripping (network path)

`<private>` tags and high-confidence secrets (API keys, tokens, cards, etc.) are redacted
before data leaves the device — see [docs/sharing.md](sharing.md) and `sense_client/privacy.py`
/ `sinain-core/src/privacy/`.

### Audio

Audio bytes are transcribed in memory and not persisted; local-whisper temp WAVs are
written to the system tmpdir and deleted immediately after transcription.

## Recommended user hardening

- Keep **FileVault** (macOS) / **BitLocker** (Windows) on.
- Exclude `~/.sinain` from cloud sync and consider excluding it from Time Machine
  (`tmutil addexclusion ~/.sinain`).

## Roadmap (not yet implemented)

This file tracks the data-at-rest hardening effort. Done: filesystem permission lockdown
(above). Planned, in priority order:

1. **Redact before persistence** — apply the `local_buffer` privacy level at the disk-write
   boundary (sense buffer, feedback/trace stores, daily notes, SITUATION.md), not only
   before network send.
2. **Logging hygiene** — stop persisting raw OCR/vision/transcript to `backend.log` by
   default; cap size + age with auto-purge.
3. **Encryption at rest** — keychain-backed key; SQLCipher for SQLite, envelope encryption
   for the JSONL/Markdown stores. (RocksDB has no app-layer encryption — evaluate an
   encrypted volume.)
4. **Retention + wipe** — TTL/size caps on notes/traces/logs; a "wipe all local data" command.

## Reporting

Found a vulnerability? Email security@sinain.com. Please do not open a public issue.
