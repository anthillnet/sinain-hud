# Plan: sinain × NemoClaw — Minimal-Action Setup

## Context

sinain needs to connect to a user's NemoClaw instance (NVIDIA Brev). Users arrive with only a running NemoClaw container + a URL and token from the Brev dashboard. The constraint: "installing an OpenClaw plugin and Mac app is OK, not many actions on top."

The plugin (`sinain-hud-plugin/`) currently has no npm package. We will add one. With npm packaging, the plugin installs via a single standard command inside the NemoClaw terminal. The Mac app (Flutter) has no setup UI; config comes from `sinain-core/.env`. There's no SSH access — only URL + token.

**Solution**: two deliverables that together give a two-action install:
1. `sinain-hud-plugin/package.json` + `sinain-hud-plugin/install.js` — npm package published as `sinain`; installs in one command inside NemoClaw terminal
2. `setup-nemoclaw.sh` — interactive Mac-side configurator: asks URL + token → writes `.env` → starts sinain

---

## Brev Network Topology

Brev exposes services via **secure HTTPS links** (`https://OpenClaw0-<id>.brevlab.com`) with Brev session auth — these can't be used by sinain-core directly (no browser cookie). For programmatic WebSocket access, the user must expose the port as a raw TCP/IP:

- **Brev dashboard → "Expose Port(s)"** → enter `18789` → gets a direct `ws://35.x.x.x:18789` connection
- OR: **Brev CLI port-forward** → `brev port-forward <instance> 18789` → `ws://localhost:18789`
- The setup wizard explains this and asks for the resulting URL

The **Code-Server terminal** (`https://Code-Server0-<id>.brevlab.com`) is the browser terminal where users run `npx sinain`.

## User Journey

```
[One-time: in Brev dashboard]
  1. Expose port 18789 (under "Expose Port(s)" → TCP)
     → note the IP shown (e.g. 35.238.211.113)
  2. Open Code-Server terminal link

[In Code-Server terminal — 1 command]
$ npx sinain
  → copies plugin files, patches openclaw.json, installs Python deps, restarts gateway
  → prints gateway token

[On Mac — 1 command]
$ ./setup-nemoclaw.sh
  → [1/4] OpenRouter key
  → [2/4] STT mode (cloud or local whisper)
  → [3/4] NemoClaw URL  (e.g. ws://35.238.211.113:18789)
  → [4/4] Gateway token (printed by npx sinain above)
  → writes sinain-core/.env, runs start.sh
  → overlay appears
```

Total friction: expose 1 port in dashboard + 2 commands + 5 fields (4th optional: backup git repo). No SSH. No file editing. No JSON.

---

## Critical Files to Create / Modify

| File | Change |
|------|--------|
| `sinain-hud-plugin/package.json` | **NEW** — npm package manifest (`"name": "sinain"`) |
| `sinain-hud-plugin/install.js` | **NEW** — postinstall/npx entrypoint; does all server-side setup |
| `setup-nemoclaw.sh` | **NEW** — Mac-side interactive configurator |
| `sinain-core/.env.example` | **UPDATE** — add NemoClaw section with comments |
| `skills/sinain-hud/HEARTBEAT.md` | **UPDATE** — document new install flow |

No changes to sinain-core TypeScript, no changes to `index.ts`, no changes to the Flutter app.

---

## 1. `sinain-hud-plugin/package.json` — npm Package Manifest

```json
{
  "name": "sinain",
  "version": "1.0.0",
  "description": "sinain OpenClaw plugin — AI overlay for macOS",
  "bin": {
    "sinain": "./install.js"
  },
  "scripts": {
    "postinstall": "node install.js"
  },
  "files": [
    "index.ts",
    "openclaw.plugin.json",
    "install.js",
    "../sinain-memory",
    "../skills/sinain-hud/HEARTBEAT.md"
  ],
  "engines": { "node": ">=18" },
  "license": "MIT"
}
```

The `bin` entry means `npx sinain` calls `install.js` directly — no separate install step needed.

---

## 2. `sinain-hud-plugin/install.js` — Server-Side Setup Script

Runs via `npx sinain` inside the NemoClaw container. Uses only Node.js built-ins + `python3` (guaranteed present).

```js
#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const HOME = os.homedir();
const PLUGIN_DIR  = path.join(HOME, ".openclaw/extensions/sinain");
const SOURCES_DIR = path.join(HOME, ".openclaw/sinain-sources");
const OC_JSON     = path.join(HOME, ".openclaw/openclaw.json");

// __dirname = sinain-hud-plugin/ inside the npm package
const PKG_DIR     = path.dirname(new URL(import.meta.url).pathname);
const KOOG_SRC    = path.join(PKG_DIR, "../sinain-memory");
const HEARTBEAT   = path.join(PKG_DIR, "../skills/sinain-hud/HEARTBEAT.md");

console.log("\nInstalling sinain plugin...");

// 1. Copy plugin files
fs.mkdirSync(PLUGIN_DIR, { recursive: true });
fs.copyFileSync(path.join(PKG_DIR, "index.ts"),             path.join(PLUGIN_DIR, "index.ts"));
fs.copyFileSync(path.join(PKG_DIR, "openclaw.plugin.json"), path.join(PLUGIN_DIR, "openclaw.plugin.json"));

// 2. Copy sinain-memory + HEARTBEAT
fs.mkdirSync(SOURCES_DIR, { recursive: true });
copyDir(KOOG_SRC, path.join(SOURCES_DIR, "sinain-memory"));
if (fs.existsSync(HEARTBEAT)) fs.copyFileSync(HEARTBEAT, path.join(SOURCES_DIR, "HEARTBEAT.md"));

// 3. Install Python deps
const reqFile = path.join(SOURCES_DIR, "sinain-memory/requirements.txt");
if (fs.existsSync(reqFile)) {
  try { execSync(`pip3 install -r "${reqFile}" --quiet`, { stdio: "inherit" }); }
  catch { console.warn("  (pip3 unavailable — Python eval features disabled)"); }
}

// 4. Patch openclaw.json
let cfg = {};
if (fs.existsSync(OC_JSON)) {
  try { cfg = JSON.parse(fs.readFileSync(OC_JSON, "utf8")); } catch {}
}
cfg.plugins ??= {};
cfg.plugins.entries ??= {};
cfg.plugins.entries["sinain"] = {
  enabled: true,
  config: {
    heartbeatPath: path.join(SOURCES_DIR, "HEARTBEAT.md"),
    memoryPath:      path.join(SOURCES_DIR, "sinain-memory"),
    sessionKey:    "agent:main:sinain"
  }
};
cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.sandbox ??= {};
cfg.agents.defaults.sandbox.sessionToolsVisibility = "all";
cfg.compaction = { mode: "safeguard", maxHistoryShare: 0.2, reserveTokensFloor: 40000 };
cfg.gateway ??= {};
cfg.gateway.bind = "lan";   // allow remote Mac to connect

fs.mkdirSync(path.dirname(OC_JSON), { recursive: true });
fs.writeFileSync(OC_JSON, JSON.stringify(cfg, null, 2));

// 5. Reload gateway
try { execSync("openclaw reload", { stdio: "pipe" }); }
catch { try { execSync("openclaw stop && sleep 1 && openclaw start --background", { stdio: "pipe" }); } catch {} }

console.log("\n✓ sinain installed.");
console.log("  Token: check your Brev dashboard → Gateway Token");
console.log("  Then run setup-nemoclaw.sh on your Mac.\n");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}
```

---

## 3. `setup-nemoclaw.sh` — Full First-Run Wizard

Lives in the sinain repo root. Replaces the need to run `setup-local-stt.sh` separately. Covers **all** configuration a new user needs: API keys, STT choice, and NemoClaw connection.

Idempotent: skips steps already configured in `.env`. Calls `setup-local-stt.sh` inline if the user picks local STT.

```bash
#!/usr/bin/env bash
set -e

SINAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SINAIN_DIR/sinain-core/.env"

# Helpers
bold='\033[1m'; green='\033[0;32m'; yellow='\033[0;33m'; reset='\033[0m'
ask() { echo -e "${bold}$1${reset}"; echo -n "  → "; read -r REPLY; }
ok()  { echo -e "  ${green}✓${reset} $*"; }
skip(){ echo -e "  ${yellow}(already set — skipping)${reset}"; }

# Load current .env if it exists
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true

echo ""
echo -e "${bold}sinain × NemoClaw Setup${reset}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: OpenRouter API key ──────────────────────────────────────────────
echo -e "${bold}[1/5] OpenRouter API key${reset}"
echo "  Used for screen analysis and audio transcription."
echo "  Get one free at openrouter.ai"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  skip; OR_KEY="$OPENROUTER_API_KEY"
else
  ask "Paste your OpenRouter API key:"
  OR_KEY="$REPLY"
fi
echo ""

# ── Step 2: Speech-to-text mode ─────────────────────────────────────────────
echo -e "${bold}[2/5] Audio transcription${reset}"
echo "  a) Cloud  — uses OpenRouter (free, no download needed)"
echo "  b) Local  — uses Whisper on your Mac (~1.5 GB model, private)"
if [ -n "${LOCAL_WHISPER_MODEL:-}" ] || [ -n "${TRANSCRIPTION_MODE:-}" ]; then
  skip; STT_MODE="existing"
else
  ask "Choose (a/b, default: a):"
  STT_MODE="${REPLY:-a}"
fi

if [ "$STT_MODE" = "b" ]; then
  echo "  Running local STT setup..."
  bash "$SINAIN_DIR/setup-local-stt.sh"
  STT_VARS="TRANSCRIPTION_MODE=local"
else
  STT_VARS="TRANSCRIPTION_MODE=openrouter"
fi
echo ""

# ── Step 3: NemoClaw URL ─────────────────────────────────────────────────────
echo -e "${bold}[3/5] NemoClaw URL${reset}"
echo "  In your Brev dashboard: Expose Port → 18789 (TCP)"
echo "  Then enter the IP shown (e.g. ws://35.238.211.113:18789)"
if [ -n "${OPENCLAW_WS_URL:-}" ]; then
  skip; RAW_URL="$OPENCLAW_WS_URL"
else
  ask "Paste your NemoClaw URL:"
  RAW_URL="$REPLY"
fi

HTTP_URL="${RAW_URL%/}"
HTTP_URL="${HTTP_URL/wss:\/\//https://}"
HTTP_URL="${HTTP_URL/ws:\/\//http://}"
WS_URL="${HTTP_URL/https:\/\//wss://}"
WS_URL="${WS_URL/http:\/\//ws://}"
echo ""

# ── Step 4: NemoClaw token ───────────────────────────────────────────────────
echo -e "${bold}[4/5] NemoClaw auth token${reset}"
echo "  From your Brev dashboard under 'Gateway Token'"
if [ -n "${OPENCLAW_WS_TOKEN:-}" ]; then
  skip; TOKEN="$OPENCLAW_WS_TOKEN"
else
  ask "Paste your auth token:"
  TOKEN="$REPLY"
fi
echo ""

# ── Step 5: Memory backup repo ──────────────────────────────────────────────
echo -e "${bold}[5/5] Memory backup (recommended)${reset}"
echo "  A private GitHub repo keeps your playbook and memory portable between instances."
echo "  Create one at github.com/new (private). Paste the SSH or HTTPS clone URL."
echo "  Leave blank to skip (memory stays on this instance only)."
if [ -n "${SINAIN_BACKUP_REPO:-}" ]; then
  skip; BACKUP_REPO="$SINAIN_BACKUP_REPO"
else
  ask "Git backup repo URL (or press Enter to skip):"
  BACKUP_REPO="$REPLY"
fi

if [ -n "$BACKUP_REPO" ]; then
  check_repo_privacy "$BACKUP_REPO"
fi
echo ""

# ── Write .env ───────────────────────────────────────────────────────────────
# Strip lines we're about to rewrite; preserve everything else
if [ -f "$ENV_FILE" ]; then
  grep -vE "^(OPENROUTER_API_KEY|TRANSCRIPTION_MODE|LOCAL_WHISPER_MODEL|OPENCLAW_|SINAIN_BACKUP_REPO)" \
    "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

cat >> "$ENV_FILE" << EOF

# ── Written by setup-nemoclaw.sh ────────────────────────────────
OPENROUTER_API_KEY=${OR_KEY}
${STT_VARS}
OPENCLAW_WS_URL=${WS_URL}
OPENCLAW_HTTP_URL=${HTTP_URL}/hooks/agent
OPENCLAW_WS_TOKEN=${TOKEN}
OPENCLAW_HTTP_TOKEN=${TOKEN}
OPENCLAW_SESSION_KEY=agent:main:sinain
EOF

if [ -n "$BACKUP_REPO" ]; then
  echo "SINAIN_BACKUP_REPO=${BACKUP_REPO}" >> "$ENV_FILE"
fi

ok "Configuration saved to sinain-core/.env"
echo ""
echo -e "${bold}Starting sinain...${reset}"
echo ""

exec "$SINAIN_DIR/start.sh"

# ── Privacy helper ───────────────────────────────────────────────────────────
check_repo_privacy() {
  local url="$1" owner_repo status is_private
  owner_repo=$(echo "$url" | sed -E 's|https://github.com/||;s|git@github.com:||;s|\.git$||')
  if [[ "$url" != *"github.com"* ]]; then
    echo "  ⚠ Non-GitHub repo — cannot auto-verify privacy."
    read -rp "  Type 'yes, it is private' to confirm: " confirm
    [[ "$confirm" == "yes, it is private" ]] || { echo "Aborted."; exit 1; }
    return
  fi
  status=$(curl -s -o /dev/null -w "%{http_code}" "https://api.github.com/repos/$owner_repo")
  if [ "$status" = "200" ]; then
    is_private=$(curl -s "https://api.github.com/repos/$owner_repo" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('private', False))")
    [ "$is_private" = "True" ] && { echo "  ✓ Repo is private"; return; }
    echo "  ✗ SECURITY ERROR: github.com/$owner_repo is PUBLIC."
    echo "    github.com/$owner_repo/settings → Change visibility → Private"
    exit 1
  elif [ "$status" = "404" ]; then
    echo "  ✓ Repo is private (not publicly accessible)"
  else
    echo "  ✗ Cannot verify repo privacy (HTTP $status). Aborting for safety."
    exit 1
  fi
}
```

---

## 4. `.env.example` Update

Add a clearly-labeled NemoClaw section:

```bash
# ── NemoClaw (NVIDIA Brev) ──────────────────────────────────────────
# Run ./setup-nemoclaw.sh to fill these in interactively.
#
# URL: expose port 18789 in Brev dashboard → use ws://YOUR-IP:18789
# Token: printed by `npx sinain` in the Code-Server terminal
OPENCLAW_WS_URL=ws://35.x.x.x:18789
OPENCLAW_WS_TOKEN=
OPENCLAW_HTTP_URL=http://35.x.x.x:18789/hooks/agent
OPENCLAW_HTTP_TOKEN=
OPENCLAW_SESSION_KEY=agent:main:sinain
```

---

## 5. `skills/sinain-hud/HEARTBEAT.md` Update

Document the new install flow in a section near the top of HEARTBEAT.md, so the agent knows how new instances are provisioned and what env vars to expect.

---

## Memory Portability — Git-Based

### What gets backed up

| Data | Location on instance | Backed up via |
|------|----------------------|---------------|
| Playbook | `~/.openclaw/workspace/playbook*.md` | `git_backup.sh` (already exists) |
| Triplestore | `~/.openclaw/workspace/` (SQLite) | `git_backup.sh` |
| Feedback logs | `~/.openclaw/workspace/feedback/` | `git_backup.sh` |

### How it works

```
[Every heartbeat tick]
  sinain-memory/git_backup.sh
    → git add -A && git commit "auto: heartbeat <timestamp>"
    → git push origin main → private GitHub repo

[New Brev instance — inside npx sinain]
  git clone <backup-repo> ~/.openclaw/workspace/
  → all memory instantly restored
```

The workspace is initialized as a git repo during `install.js`. The git remote (`BACKUP_GIT_URL`) is passed in via environment variable, set by `setup-nemoclaw.sh`.

### Privacy guard — required before every git operation

Both `install.js` and `setup-nemoclaw.sh` call a `checkRepoPrivacy()` function. **Hard error if repo is public.** Never silently continue.

**Logic (GitHub repos):**
```
GET https://api.github.com/repos/<owner>/<repo>  (no auth header)
  → 200 + "private": false  →  ABORT: "Repo is PUBLIC — refusing to backup memory"
  → 200 + "private": true   →  OK
  → 404                     →  OK (private: unauthenticated request can't see it)
  → other error             →  ABORT for safety
```
For non-GitHub repos: require user to explicitly type `"yes, it is private"` — no silent skipping.

**`checkRepoPrivacy` in `install.js`:**
```js
async function checkRepoPrivacy(url) {
  const m = url.match(/(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^.]+)/);
  if (!m) {
    if (!process.env.SINAIN_BACKUP_REPO_CONFIRMED) {
      throw new Error("Non-GitHub repo: cannot verify privacy.\nSet SINAIN_BACKUP_REPO_CONFIRMED=1 only if you are CERTAIN the repo is private.");
    }
    return;
  }
  const ownerRepo = m[1].replace(/\.git$/, "");
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`);
  if (res.status === 200) {
    const data = await res.json();
    if (!data.private) throw new Error(
      `SECURITY: github.com/${ownerRepo} is PUBLIC.\nMake it private: github.com/${ownerRepo}/settings → Change visibility → Private`
    );
  } else if (res.status !== 404) {
    throw new Error(`Cannot verify repo privacy (HTTP ${res.status}). Aborting.`);
  }
}
```

### What install.js does for memory

```js
const backupUrl = process.env.SINAIN_BACKUP_REPO;
const WORKSPACE = path.join(HOME, ".openclaw/workspace");

if (backupUrl) {
  await checkRepoPrivacy(backupUrl);  // hard error if public
  if (!fs.existsSync(path.join(WORKSPACE, ".git"))) {
    console.log("  Restoring memory from backup repo...");
    execSync(`git clone "${backupUrl}" "${WORKSPACE}" --quiet`, { stdio: "inherit" });
    console.log("  ✓ Memory restored");
  } else {
    execSync(`git -C "${WORKSPACE}" remote set-url origin "${backupUrl}"`, { stdio: "pipe" });
  }
}
```

---

## Key Considerations

| Issue | Resolution |
|-------|-----------|
| `gateway.bind` defaults to loopback | `install.js` sets `"bind": "lan"` in openclaw.json |
| `operator.admin` scope needed | `sessionToolsVisibility: all` set by `install.js` |
| Token not visible to user | `install.js` prints where to find it; Brev dashboard shows it |
| sinain-memory Python deps | `install.js` runs `pip3 install -r requirements.txt` |
| `uv` may be absent | `install.js` uses `pip3` directly, not `uv` |
| Existing `.env` not overwritten | `setup-nemoclaw.sh` strips old `OPENCLAW_` lines, appends new block |
| Session key must be `agent:main:sinain` | Hardcoded in `install.js`, no user input needed |
| Memory portability | Git-based: workspace committed on every heartbeat tick; restored via `git clone` on new instances |
| npm package includes sinain-memory | `files` array in `package.json` bundles `../sinain-memory` |
| Plugin updates | `npm update -g sinain` re-runs postinstall automatically |

---

## Verification Checklist

1. In Brev terminal: `SINAIN_BACKUP_REPO=<git-url> npx sinain` — prints "✓ sinain installed" and clones memory if repo exists
2. `cat ~/.openclaw/openclaw.json` — contains `"sinain": { "enabled": true }`
3. On Mac: `./setup-nemoclaw.sh` → 5 prompts → sinain starts
4. sinain-core logs show: `[openclaw-ws] authenticated`
5. Speak a question → overlay shows agent response
6. Check `SITUATION.md` updates after agent tick
7. Stop old instance → create new instance → `SINAIN_BACKUP_REPO=<same-url> npx sinain` → memory fully restored
8. `npm update -g sinain` in Brev terminal — updates plugin, postinstall re-runs
