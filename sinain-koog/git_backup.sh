#!/usr/bin/env bash
# Phase 1: Git backup — commit and push any uncommitted changes in the workspace.
# Runs from the workspace root. Exits 0 on success or nothing to commit, 1 on push failure.

set -euo pipefail

changes=$(git status --porcelain 2>/dev/null || true)

if [ -z "$changes" ]; then
    echo "nothing to commit"
    exit 0
fi

git add -A
git commit -m "auto: heartbeat $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin main

# Output the commit hash
git rev-parse --short HEAD
