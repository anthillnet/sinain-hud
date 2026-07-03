#!/usr/bin/env python3
"""
AX reader spike — feasibility probe for reading off-screen / occluded window text.

Reads the text content of a target app's windows via the macOS Accessibility
(AXUIElement) API — WITHOUT needing the window to be visible, frontmost, or on
the current Space. This is the "semantic content, not pixels" path discussed for
Sinain: if it returns clean text here, sense_client can emit it as a `source:"ax"`
event with zero vision cost.

This is a THROWAWAY probe. Goal: build a per-app feasibility matrix. Point it at
Mail, Slack, Notes, VS Code, Chrome, Safari, Notion, etc. and see what comes back.

Usage:
    python3 ax_dump.py "Mail"            # dump text of all of Mail's windows
    python3 ax_dump.py "Google Chrome"   # (note: browsers expose only the ACTIVE tab via AX)
    python3 ax_dump.py --list            # list running apps with windows
    python3 ax_dump.py "Slack" --max-chars 4000 --depth 60

Only needs pyobjc-core + Cocoa (already sense_client deps) — the AX functions are
loaded directly from the system ApplicationServices framework, so no extra
`pip install` is required. First use needs the Accessibility permission in
System Settings > Privacy & Security > Accessibility for your terminal/Python.
"""

import argparse
import sys
import time

import objc
from Foundation import NSBundle
from AppKit import NSWorkspace

# --- Load AX* C functions from the system framework (no pyobjc-framework-ApplicationServices needed) ---
_bundle = NSBundle.bundleWithPath_("/System/Library/Frameworks/ApplicationServices.framework")
_FUNCS = [
    ("AXUIElementCreateApplication", b"@i"),       # AXUIElementRef create(pid_t)
    ("AXUIElementCopyAttributeValue", b"i@@o^@"),  # AXError(elem, CFString attr, out CFTypeRef) -> (err, value)
    ("AXIsProcessTrustedWithOptions", b"Z@"),      # Boolean(CFDictionary options)
    ("AXUIElementSetMessagingTimeout", b"i@f"),     # AXError(elem, float seconds)
]
_AX = {}
objc.loadBundleFunctions(_bundle, _AX, _FUNCS)

AXUIElementCreateApplication = _AX["AXUIElementCreateApplication"]
AXUIElementCopyAttributeValue = _AX["AXUIElementCopyAttributeValue"]
AXIsProcessTrustedWithOptions = _AX["AXIsProcessTrustedWithOptions"]
AXUIElementSetMessagingTimeout = _AX["AXUIElementSetMessagingTimeout"]

# Roles whose AXValue/AXTitle carry user-visible text worth collecting.
TEXT_ROLES = {
    "AXStaticText",
    "AXTextArea",
    "AXTextField",
    "AXHeading",
    "AXLink",
    "AXCell",
    "AXMenuItem",
}

SUCCESS = 0  # kAXErrorSuccess


def ax_attr(element, attr):
    """Return an AX attribute value, or None on any error."""
    err, value = AXUIElementCopyAttributeValue(element, attr, None)
    if err != SUCCESS:
        return None
    return value


def find_pid(app_name):
    """Resolve an app display name (or bundle id substring) to a pid."""
    name_lower = app_name.lower()
    matches = []
    for app in NSWorkspace.sharedWorkspace().runningApplications():
        local = app.localizedName() or ""
        bundle = app.bundleIdentifier() or ""
        if name_lower in local.lower() or name_lower in bundle.lower():
            matches.append((local, app.processIdentifier(), bundle))
    if not matches:
        return None, []
    return matches[0][1], matches


def collect_text(element, depth, max_depth, budget, seen=0):
    """Recursively walk the AX tree, collecting text fragments. Returns (fragments, nodes_visited)."""
    if depth > max_depth or seen > budget:
        return [], seen
    fragments = []
    seen += 1

    role = ax_attr(element, "AXRole")
    if role in TEXT_ROLES:
        for attr in ("AXValue", "AXTitle"):
            val = ax_attr(element, attr)
            if isinstance(val, str) and val.strip():
                fragments.append(val.strip())
                break  # don't duplicate title+value of the same node

    children = ax_attr(element, "AXChildren") or []
    for child in children:
        if seen > budget:
            break
        sub, seen = collect_text(child, depth + 1, max_depth, budget, seen)
        fragments.extend(sub)

    return fragments, seen


def dump_app(app_name, max_depth, max_chars, node_budget):
    pid, matches = find_pid(app_name)
    if pid is None:
        print(f"✗ No running app matches '{app_name}'. Try --list.")
        return
    if len(matches) > 1:
        print(f"ℹ Multiple matches; using '{matches[0][0]}' (pid {pid}). Others: "
              + ", ".join(m[0] for m in matches[1:]))

    app_el = AXUIElementCreateApplication(pid)
    try:
        AXUIElementSetMessagingTimeout(app_el, 2.0)  # don't let a wedged app hang the probe
    except Exception:
        pass

    windows = ax_attr(app_el, "AXWindows")
    if windows is None:
        print("✗ Could not read AXWindows. Likely causes:")
        print("  - Accessibility permission not granted (check System Settings).")
        print("  - App does not expose an AX tree (some Electron/Java apps).")
        return
    if len(windows) == 0:
        print("⚠ App is running but has 0 AX windows (all minimized? agent app?).")
        return

    print(f"✓ '{matches[0][0]}' (pid {pid}) — {len(windows)} window(s)\n")
    for i, win in enumerate(windows):
        title = ax_attr(win, "AXTitle") or "(untitled)"
        minimized = ax_attr(win, "AXMinimized")
        t0 = time.time()
        frags, visited = collect_text(win, 0, max_depth, node_budget)
        elapsed = (time.time() - t0) * 1000
        text = "\n".join(frags)
        flag = " [MINIMIZED]" if minimized else ""
        print(f"── window {i}: {title}{flag}")
        print(f"   nodes={visited}  fragments={len(frags)}  chars={len(text)}  walk={elapsed:.0f}ms")
        if text:
            preview = text[:max_chars]
            print("   " + preview.replace("\n", "\n   "))
            if len(text) > max_chars:
                print(f"   … (+{len(text) - max_chars} more chars)")
        else:
            print("   (no text extracted)")
        print()


def list_apps():
    print("Running apps with at least one AX window:\n")
    for app in NSWorkspace.sharedWorkspace().runningApplications():
        name = app.localizedName()
        if not name:
            continue
        el = AXUIElementCreateApplication(app.processIdentifier())
        wins = ax_attr(el, "AXWindows")
        if wins:
            print(f"  {len(wins):>2} win  {name}")


def main():
    p = argparse.ArgumentParser(description="Probe AX text extraction for an app's windows.")
    p.add_argument("app", nargs="?", help="App name or bundle id substring (e.g. 'Mail').")
    p.add_argument("--list", action="store_true", help="List running apps with windows.")
    p.add_argument("--depth", type=int, default=40, help="Max AX tree recursion depth.")
    p.add_argument("--max-chars", type=int, default=2000, help="Preview chars per window.")
    p.add_argument("--budget", type=int, default=8000, help="Max AX nodes to visit per window.")
    args = p.parse_args()

    trusted = AXIsProcessTrustedWithOptions({"AXTrustedCheckOptionPrompt": True})
    if not trusted:
        print("⚠ Accessibility permission not yet granted.")
        print("  A system prompt should appear. Grant it to your terminal/Python,")
        print("  then re-run. (System Settings > Privacy & Security > Accessibility)\n")

    if args.list:
        list_apps()
    elif args.app:
        dump_app(args.app, args.depth, args.max_chars, args.budget)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
