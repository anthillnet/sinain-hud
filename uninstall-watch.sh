#!/usr/bin/env bash
# Trash-watcher — launchd runs this (LaunchAgent com.sinain.hud.trash-watcher)
# whenever the watched Sinain.app bundle path changes. If the app is genuinely
# gone (the user moved it to the Trash) — not merely being updated — run the
# uninstaller, which preserves the knowledge graph and removes this watcher.
#
# Debounce first: a DMG over-install briefly removes then re-adds the bundle, so
# wait, then re-check that the app is actually absent from all install spots.
set -u
sleep 6
for p in "/Applications/Sinain.app" "$HOME/Applications/Sinain.app"; do
  [ -d "$p" ] && exit 0   # still installed → not a trash event (update/move-in)
done

SELF_DIR="$HOME/.sinain/uninstall"
[ -f "$SELF_DIR/uninstall.sh" ] || exit 0

# Run the uninstaller from /tmp so it can delete ~/.sinain/uninstall (this very
# directory) without pulling the script out from under a running process.
TMP="/tmp/sinain-uninstall.$$.sh"
cp "$SELF_DIR/uninstall.sh" "$TMP" 2>/dev/null || exit 0
bash "$TMP" --yes
rm -f "$TMP"
