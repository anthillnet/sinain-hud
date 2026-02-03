import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { ContextWindow, ContextRichness, RichnessPreset } from "../types.js";

/**
 * Richness presets — control how much context goes into agent analysis and escalation.
 *
 * lean:     For selective mode. Minimal context, fast + cheap.
 * standard: For focus mode. Moderate detail.
 * rich:     Full context. Maximum detail for thorough agent analysis.
 */
export const RICHNESS_PRESETS: Record<ContextRichness, RichnessPreset> = {
  lean:     { maxScreenEvents: 10, maxAudioEntries: 5,  maxOcrChars: 400,  maxTranscriptChars: 400  },
  standard: { maxScreenEvents: 20, maxAudioEntries: 10, maxOcrChars: 1000, maxTranscriptChars: 800  },
  rich:     { maxScreenEvents: 50, maxAudioEntries: 30, maxOcrChars: 4000, maxTranscriptChars: 2000 },
} as const;

/** App name normalization map (consistent display names). */
const APP_NAMES: Record<string, string> = {
  "idea": "IntelliJ IDEA",
  "code": "VS Code",
  "code - insiders": "VS Code Insiders",
  "webstorm": "WebStorm",
  "pycharm": "PyCharm",
  "datagrip": "DataGrip",
  "google chrome": "Chrome",
  "firefox": "Firefox",
  "safari": "Safari",
  "telegram lite": "Telegram",
  "telegram": "Telegram",
  "iterm2": "iTerm",
  "terminal": "Terminal",
  "finder": "Finder",
  "audio midi setup": "Audio MIDI Setup",
};

export function normalizeAppName(app: string): string {
  return APP_NAMES[app.toLowerCase()] || app;
}

/** Short app names for overlay feed (compact display). */
const APP_SHORT_NAMES: Record<string, string> = {
  "IntelliJ IDEA": "IDEA",
  "IntelliJ IDEA Ultimate": "IDEA",
  "idea": "IDEA",
  "Google Chrome": "Chrome",
  "Visual Studio Code": "Code",
  "Code - Insiders": "Code",
  "iTerm2": "iTerm",
  "Terminal": "Term",
  "Telegram": "TG",
  "WebStorm": "WS",
  "PyCharm": "PyCharm",
  "DataGrip": "DG",
  "Finder": "Finder",
};

export function shortAppName(app: string): string {
  if (APP_SHORT_NAMES[app]) return APP_SHORT_NAMES[app];
  const lower = app.toLowerCase();
  for (const [key, value] of Object.entries(APP_SHORT_NAMES)) {
    if (key.toLowerCase() === lower) return value;
  }
  return app;
}

/**
 * Build a unified context window from in-process buffers.
 * Replaces both relay's buildContextWindow() and bridge's ContextManager.
 *
 * No HTTP round-trips — direct access to feed and sense buffers.
 */
export function buildContextWindow(
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
  richness: ContextRichness = "standard",
  maxAgeMs = 120_000,
): ContextWindow {
  const preset = RICHNESS_PRESETS[richness];
  const cutoff = Date.now() - maxAgeMs;

  // Audio: extract transcript text from feed items tagged as 'audio'
  const audioItems = feedBuffer.queryBySource("audio", cutoff)
    .slice(-preset.maxAudioEntries);

  // Screen: get sense events within the time window
  const screenEvents = senseBuffer.queryByTime(cutoff);

  // Current app
  const latestSense = screenEvents[screenEvents.length - 1];
  const currentApp = latestSense?.meta.app || "unknown";

  // Deduplicate OCR text (consecutive identical OCR is noise)
  const dedupedScreen = [];
  let lastOcr = "";
  for (const e of screenEvents) {
    if (e.ocr && e.ocr !== lastOcr) {
      dedupedScreen.push(e);
      lastOcr = e.ocr;
    } else if (!e.ocr && e.type === "context") {
      dedupedScreen.push(e);
    }
  }

  // App transition timeline
  const appHistory = senseBuffer.appHistory(cutoff);

  // Limit to preset maximums, newest first for recency weighting
  const sortedScreen = dedupedScreen.slice(-preset.maxScreenEvents).reverse();

  // Compute newest event timestamp
  const newestEventTs = Math.max(
    audioItems[audioItems.length - 1]?.ts || 0,
    screenEvents[screenEvents.length - 1]?.ts || 0
  );

  return {
    audio: audioItems,
    screen: sortedScreen,
    currentApp,
    appHistory,
    audioCount: audioItems.length,
    screenCount: screenEvents.length,
    windowMs: maxAgeMs,
    newestEventTs,
    preset,
  };
}
