// Structural project/thread identity — one project = one stable thread,
// keyed off the window context (the most reliable signal we have), NOT fuzzy
// content matching. Editors → the repo; chat/agent apps → the conversation;
// browsers → the page/site; else the app.
//
// This is the identity half of the work-state model's extractor, ported
// standalone for the save-offer episode tracker: app-level episodes merged a
// whole multi-app work session into one never-ending episode, while
// project-level keys change exactly when the user actually changes context.

const _APP_SUFFIX =
  /\s+[—–-]\s+(Visual Studio Code|Zed|IntelliJ IDEA|PyCharm|WebStorm|Xcode|Cursor|Sublime Text|Google Chrome|Google Docs|Google Sheets|Google Slides|YouTube|Safari|Mozilla Firefox|Firefox|Microsoft Edge|Claude|ChatGPT|Arc)\s*$/i;

function cleanTitle(t: string): string {
  return t.replace(/^\(\d+\)\s*/, "").replace(_APP_SUFFIX, "").trim();
}

// Browser titles append "<page> - <Browser> - <Profile>" — strip from the
// browser name onward, and drop the unread-count prefix that churns the key.
function browserPage(title: string): string | null {
  const t = title
    .replace(/\s+[—–-]\s+(Google Chrome|Chromium|Safari|Mozilla Firefox|Firefox|Microsoft Edge|Arc|Brave|Opera)\b.*$/i, "")
    .replace(/^\(\d[\d,]*\)\s*/, "")
    .trim();
  return t || null;
}

function editorProject(title: string): string | null {
  const t = cleanTitle(title);
  if (!t) return null;
  // "file.ext — repo — branch" / "repo – file.ext:line" → the repo is the
  // segment that isn't a filename/path; prefer the longest (branches are short).
  const parts = t.split(/\s+[—–]\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const nonFile = parts.filter((p) => !/\.[a-z0-9]{1,5}$/i.test(p) && !p.includes("/"));
  const pool = nonFile.length ? nonFile : parts;
  return pool.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function deriveProject(app: string, title: string): { key: string; label: string } {
  const a = app.toLowerCase();
  if (/zed|vscode|vs code|code|cursor|sublime|intellij|idea|pycharm|webstorm|goland|rubymine|clion|rider|xcode|android studio|nova|vim|nvim|emacs/.test(a)) {
    const proj = editorProject(title);
    if (proj) return { key: `proj:${proj.toLowerCase()}`, label: proj };
  }
  if (/claude|chatgpt|gemini|copilot|perplexity/.test(a)) {
    const conv = cleanTitle(title) || app;
    return { key: `chat:${conv.toLowerCase()}`, label: conv };
  }
  if (/chrome|safari|firefox|arc|brave|edge|opera/.test(a)) {
    const page = browserPage(title);
    if (page) {
      // Web apps churn their page titles — key by a stable site/repo instead.
      if (/\bgmail\b/i.test(title)) return { key: "web:gmail", label: "Gmail" };
      const repo = page.match(/([\w.-]+\/[\w.-]+)(?:[@#]|\b)/); // owner/repo (GitHub…)
      if (repo) return { key: `web:${repo[1].toLowerCase()}`, label: repo[1] };
      const short = page.split(/\s+/).slice(0, 5).join(" ");
      return { key: `web:${short.toLowerCase()}`, label: page };
    }
  }
  return { key: `app:${a}`, label: app };
}
