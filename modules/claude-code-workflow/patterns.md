# Claude Code Workflow

## Plan-First Development
- Non-trivial tasks start in plan mode: explore → design → review → write plan file → get approval
- Plans are .md files with Context, Design, Changes (file-by-file with line numbers), Verification
- Launch parallel Explore agents (up to 3) to understand codebase before proposing changes
- Always identify existing utilities to reuse — avoid reinventing

## Deployment Pipeline
- Local dev → SCP to Strato VPS (85.214.180.247) → docker compose restart
- Plugin/config changes require restart; HEARTBEAT.md and koog scripts auto-sync
- Verify via log grep: `sinain-hud: plugin registered` and `[heartbeat] started`
- .py scripts use deploy-once policy (won't overwrite workspace edits)

## Permission & Safety
- Progressive permission allowlist in .claude/settings.local.json (300+ commands)
- Pre-approved git commits with exact message templates
- Domain-specific WebFetch allowlist (arxiv, github, opencv docs)
- Never skip hooks (--no-verify), never force-push to main

## Observability
- /sinain_status for session metadata (tokens, compactions, error rate)
- /sinain_health for watchdog report (transcript size, staleness, overflow counter)
- /sinain_eval for latest evaluation metrics (passRate, judgeAvg)
- Telegram alerts for outage detection, recovery, overflow auto-reset
