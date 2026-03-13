---
name: backport-to-enterprise
description: Cherry-pick commits from origin/main onto enterprise/main to keep the enterprise repo in sync with public fixes
---

# Skill: backport-to-enterprise

Backports one or more commits that have landed in the **public** repo (`origin/main`) into
the **enterprise** repo (`anthillnet/sinain-hud-enterprise`) via a short-lived branch + PR.

## When to use

Run `/backport-to-enterprise` after any fix is merged to `origin/main` that should also be in
enterprise — typecheck fixes, bug fixes, security patches. Enterprise-only code (skills, plugin
internals) does NOT need backporting in the other direction.

## Remote layout

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/anthillnet/sinain-hud.git` | Public OSS repo |
| `enterprise` | `https://github.com/anthillnet/sinain-hud-enterprise.git` | Private enterprise repo |

## Steps

### 1. Identify commit(s) to backport

```bash
git log --oneline origin/main | head -10
git log --oneline enterprise/main | head -10
```

Ask the user (or infer from context) which SHA(s) should be backported. If the current conversation
already established the SHA(s), skip the prompt.

### 2. Create a branch from enterprise/main

Name it after the fix, e.g. `fix/<short-description>`:

```bash
git checkout enterprise/main -b fix/<short-description>
```

### 3. Cherry-pick the commit(s)

```bash
git cherry-pick <sha> [<sha2> ...]
```

If conflicts occur, resolve them and `git cherry-pick --continue`.

### 4. Push to enterprise

```bash
git push enterprise fix/<short-description>
```

### 5. Open a PR in enterprise

```bash
gh pr create --repo anthillnet/sinain-hud-enterprise \
  --title "<same title as public commit/PR>" \
  --body "Backport of <origin commit sha> from anthillnet/sinain-hud.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --head fix/<short-description> \
  --base main
```

### 6. Merge (admin override since there's no CI gating enterprise PRs)

Check CI status first if any checks are configured:

```bash
gh pr checks <PR-number> --repo anthillnet/sinain-hud-enterprise
```

Then merge:

```bash
gh pr merge <PR-number> --repo anthillnet/sinain-hud-enterprise --merge --admin
```

### 7. Return confirmation

Output the enterprise PR URL and the merged SHA for the record.

## Gotchas

- `enterprise/main` and `origin/main` share no git history (independent repos), so you **must**
  branch from `enterprise/main`, not from the public branch.
- If the cherry-pick conflicts, it's usually because enterprise already has a diverged version of
  the same file — resolve by keeping the enterprise version of unrelated hunks and only applying
  the targeted fix.
- `gh pr create` will warn about uncommitted changes in the working tree — ignore if they're
  unrelated workspace files (xcconfig, sinain-koog config).

## Example

After merging public PR #14 which included `f453493` (TS2322 fix):

```bash
git checkout enterprise/main -b fix/situation-writer-ts2322
git cherry-pick f453493
git push enterprise fix/situation-writer-ts2322
gh pr create --repo anthillnet/sinain-hud-enterprise \
  --title "fix: return empty string on mkdir failure in writeSituationMd (TS2322)" \
  --body "Backport of f453493 from anthillnet/sinain-hud.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --head fix/situation-writer-ts2322 --base main
gh pr merge 3 --repo anthillnet/sinain-hud-enterprise --merge --admin
```
