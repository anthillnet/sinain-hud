// Launch a desktop chat app (Claude / ChatGPT) on a ROI seed.
//
// The app pulls the seed via the sinain_roi MCP tool, so the launch only needs
// to (a) open the app and (b) inject a short pointer naming the seed id, then
// auto-send. Claude takes the pointer inline via the claude:// ?q= deep link;
// ChatGPT has no prefill, so the pointer rides the clipboard and we paste it.
// Auto-send is a synthesized Return via AppleScript (needs Accessibility
// permission for the core process). All best-effort + fire-and-forget.
//
// macOS only (the overlay product is macOS-only).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export type DesktopType = "claude_desktop" | "chatgpt_desktop";

const APP_NAME: Record<DesktopType, string> = {
  claude_desktop: "Claude",
  chatgpt_desktop: "ChatGPT",
};

/** Is the desktop app installed? Gates the roster so we never offer a missing app. */
export function desktopAppInstalled(type: DesktopType): boolean {
  const app = APP_NAME[type];
  if (!app) return false;
  if (existsSync(`/Applications/${app}.app`)) return true;
  if (existsSync(`${homedir()}/Applications/${app}.app`)) return true;
  return false;
}

function osascript(lines: string[]): void {
  const args = lines.flatMap((l) => ["-e", l]);
  execFile("osascript", args, () => { /* best-effort */ });
}

/** Open the app on the given ROI seed id and auto-send a pull pointer. */
export function launchDesktop(type: DesktopType, seedId: string): void {
  // Benign data-fetch framing — NOT "follow its instructions" (trips ChatGPT's
  // connector safety check). Help-oriented, not summarize-the-screen: the ROI is
  // context for assisting, not a thing to describe back.
  const pointer = `Call the sinain_roi tool (id "${seedId}") to load context on what I'm working on, then help me with it.`;
  if (type === "claude_desktop") {
    const url = `claude://claude.ai/new?q=${encodeURIComponent(pointer)}`;
    execFile("open", [url], () => {});
    // Let the new-chat window + prefill render, then activate + Return.
    setTimeout(() => osascript([
      'tell application "Claude" to activate',
      "delay 0.6",
      'tell application "System Events" to key code 36',
    ]), 4000);
  } else if (type === "chatgpt_desktop") {
    // No prefill: pointer rides the clipboard, paste into a fresh chat.
    execFile("/bin/sh", ["-c", `printf %s ${shq(pointer)} | pbcopy`], () => {});
    execFile("open", ["chatgpt://"], () => {});
    setTimeout(() => osascript([
      'tell application "ChatGPT" to activate',
      "delay 0.8",
      'tell application "System Events" to keystroke "n" using {command down}',
      "delay 0.8",
      'tell application "System Events" to keystroke "v" using {command down}',
      "delay 0.6",
      'tell application "System Events" to key code 36',
    ]), 4000);
  }
}

/** Single-quote a string for /bin/sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
