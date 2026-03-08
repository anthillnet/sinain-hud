---
name: contribute-public
description: Push branch to enterprise + bridge fork, open PR to public repo
---

# Skill: contribute-public

Contributes the current branch from the enterprise private repo to the public OSS repo via a personal fork bridge.

## Remote layout

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/anthillnet/sinain-hud.git` | Public OSS repo (PR target) |
| `enterprise` | `https://github.com/anthillnet/sinain-hud-enterprise.git` | Private enterprise repo (source of truth) |
| `bridge` | `https://github.com/Geravant/sinain-hud-1.git` | Personal fork of origin — staging for cross-repo PRs |

> **Note:** The bridge fork is public by GitHub constraint — GitHub does not allow private forks of public repos. Only sanitized, public-ready code should be pushed there.

## Steps

### 1. Confirm current branch

```bash
git branch --show-current
git log --oneline -5
```

Confirm with the user what's being contributed and that it's safe to expose publicly.

### 2. Push to enterprise (private record)

```bash
git push enterprise <branch>
```

This ensures the enterprise repo has a permanent record of the contribution before it goes public.

### 3. Push to bridge fork (staging for PR)

```bash
git push bridge <branch>
```

This pushes to the personal fork (`Geravant/sinain-hud-1`) which serves as the PR head.

### 4. Open PR to public repo via `gh api`

```bash
BRANCH=$(git branch --show-current)
gh api repos/anthillnet/sinain-hud/pulls \
  --method POST \
  --field title="<PR title>" \
  --field body="<PR description>" \
  --field head="Geravant:${BRANCH}" \
  --field base="main" \
  --jq '.html_url'
```

**Critical:** Use `Geravant:<branch>` format for `head` — NOT `Geravant/sinain-hud-1:<branch>` and NOT `--head` flag on `gh pr create`. The `gh api` approach is required for cross-repo PRs where origin and bridge are different repos.

### 5. Return PR URL

Output the PR URL so the user can review and merge.

## Why this workflow exists

GitHub blocks:
- Private forks of public repos within the same org
- Making public forks of public repos private

`sinain-hud-enterprise` is **not** a GitHub fork of `sinain-hud` — it's an independent repo in the same org. This means standard fork-based PRs don't work; the personal bridge fork (`Geravant/sinain-hud-1`) is required as an intermediate that GitHub recognizes as a fork of origin.

## Example invocation

When the user runs `/contribute-public`, execute the full 3-step flow (push enterprise → push bridge → open PR), asking for PR title/body if not provided.
