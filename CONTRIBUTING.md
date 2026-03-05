# Contributing to SinainHUD

Thanks for your interest in contributing! This guide covers the basics.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/Geravant/sinain-hud/issues) with:
- What you expected vs. what happened
- macOS version and relevant component (overlay, sinain-core, sense_client)
- Steps to reproduce

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run the relevant checks (see below)
4. Open a Pull Request with a clear description of what changed and why

## Code Style

Follow the existing patterns in each component:

| Component | Language | Style |
|-----------|----------|-------|
| **sinain-core/** | TypeScript | ESM, `tsx` runner |
| **overlay/** | Dart + Swift | Flutter conventions, Swift for native plugins |
| **sense_client/** | Python | Type hints, `snake_case` |
| **sinain-koog/** | Python | Same as sense_client |
| **sinain-hud-plugin/** | TypeScript | OpenClaw plugin API |

## Testing & Checks

```bash
# sinain-core — type check
cd sinain-core && npm run typecheck

# overlay — static analysis + tests
cd overlay && flutter analyze && flutter test

# sense_client — run tests
cd sense_client && python -m pytest tests/
```

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add adaptive SSIM threshold to sense_client
fix: overlay crash on macOS 11 when toggling click-through
docs: update Quick Start with sense_client steps
```

## Questions?

Open an issue or start a discussion — we're happy to help.
