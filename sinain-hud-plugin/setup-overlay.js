#!/usr/bin/env node
// sinain setup-overlay — download pre-built overlay app (or build from source)

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const APP_DIR = path.join(SINAIN_DIR, "overlay-app");
const VERSION_FILE = path.join(APP_DIR, "version.json");
const IS_WINDOWS = os.platform() === "win32";

// Platform-specific asset and app path
const ASSET_NAME = IS_WINDOWS ? "sinain_hud_windows.zip" : "sinain_hud.app.zip";
const APP_PATH = IS_WINDOWS
  ? path.join(APP_DIR, "sinain_hud.exe")
  : path.join(APP_DIR, "sinain_hud.app");

const REPO = "anthillnet/sinain-hud";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

// Legacy source-build paths
const REPO_DIR = path.join(SINAIN_DIR, "overlay-repo");
const OVERLAY_LINK = path.join(SINAIN_DIR, "overlay");

const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg)  { console.log(`${BOLD}[setup-overlay]${RESET} ${msg}`); }
function ok(msg)   { console.log(`${BOLD}[setup-overlay]${RESET} ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${BOLD}[setup-overlay]${RESET} ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.error(`${BOLD}[setup-overlay]${RESET} ${RED}✗${RESET} ${msg}`); process.exit(1); }

// ── Entry point (only when run directly, not when imported) ──────────────────

const isMain = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], "file://").href
);

if (isMain) {
  const args = process.argv.slice(2);
  const fromSource = args.includes("--from-source");
  const forceUpdate = args.includes("--update");

  if (fromSource) {
    await buildFromSource();
  } else {
    await downloadOverlay({ forceUpdate });
  }
}

// ── Download pre-built .app ──────────────────────────────────────────────────

export async function downloadOverlay({ silent = false, forceUpdate = false } = {}) {
  const _log = silent ? () => {} : log;
  const _ok = silent ? () => {} : ok;
  const _warn = silent ? () => {} : warn;

  fs.mkdirSync(APP_DIR, { recursive: true });

  // Find latest overlay release
  _log("Checking for latest overlay release...");
  let release;
  try {
    const res = await fetch(`${RELEASES_API}?per_page=20`, {
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const releases = await res.json();
    release = releases.find(r => r.tag_name?.startsWith("overlay-v"));
    if (!release) throw new Error("No overlay release found");
  } catch (e) {
    if (silent) return false;
    fail(`Failed to fetch releases: ${e.message}\n  Try: sinain setup-overlay --from-source`);
  }

  const tag = release.tag_name;
  const version = tag.replace("overlay-v", "");

  // Check if already up-to-date
  if (!forceUpdate && fs.existsSync(VERSION_FILE) && fs.existsSync(APP_PATH)) {
    try {
      const local = JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
      if (local.tag === tag) {
        _ok(`Overlay already up-to-date (${version})`);
        return true;
      }
      _log(`Updating: ${local.tag} → ${tag}`);
    } catch { /* corrupt version file — re-download */ }
  }

  // Find the .zip asset for this platform
  const zipAsset = release.assets?.find(a => a.name === ASSET_NAME);
  if (!zipAsset) {
    if (silent) return false;
    fail(`Release ${tag} has no ${ASSET_NAME} asset.\n  Try: sinain setup-overlay --from-source`);
  }

  // Download with progress
  _log(`Downloading overlay ${version} for ${IS_WINDOWS ? "Windows" : "macOS"} (${formatBytes(zipAsset.size)})...`);
  const zipPath = path.join(APP_DIR, ASSET_NAME);

  try {
    const res = await fetch(zipAsset.browser_download_url, {
      signal: AbortSignal.timeout(120000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const total = parseInt(res.headers.get("content-length") || "0");
    const chunks = [];
    let downloaded = 0;

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      if (total > 0 && !silent) {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\r${BOLD}[setup-overlay]${RESET} ${DIM}${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})${RESET}`);
      }
    }
    if (!silent) process.stdout.write("\n");

    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(zipPath, buffer);
    _ok(`Downloaded ${formatBytes(buffer.length)}`);
  } catch (e) {
    if (silent) return false;
    fail(`Download failed: ${e.message}`);
  }

  // Remove old app if present
  if (fs.existsSync(APP_PATH)) {
    fs.rmSync(APP_PATH, { recursive: true, force: true });
  }

  // Extract
  _log("Extracting...");
  if (IS_WINDOWS) {
    try {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${APP_DIR}' -Force"`,
        { stdio: "pipe" }
      );
    } catch (e) {
      if (silent) return false;
      fail(`Extraction failed: ${e.message}`);
    }
  } else {
    // ditto preserves macOS extended attributes (critical for code signing)
    try {
      execSync(`ditto -x -k "${zipPath}" "${APP_DIR}"`, { stdio: "pipe" });
    } catch {
      try {
        execSync(`unzip -o -q "${zipPath}" -d "${APP_DIR}"`, { stdio: "pipe" });
      } catch (e) {
        if (silent) return false;
        fail(`Extraction failed: ${e.message}`);
      }
    }

    // Remove quarantine attribute (ad-hoc signed app downloaded from internet)
    try {
      execSync(`xattr -cr "${APP_PATH}"`, { stdio: "pipe" });
    } catch { /* xattr may not be needed */ }
  }

  // Write version marker
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    tag,
    version,
    installedAt: new Date().toISOString(),
  }, null, 2));

  // Clean up zip
  fs.unlinkSync(zipPath);

  _ok(`Overlay ${version} installed`);
  if (!silent) {
    console.log(`
${GREEN}✓${RESET} Overlay ready!
  Location: ${APP_PATH}
  The overlay will auto-start with: ${BOLD}sinain start${RESET}
`);
  }
  return true;
}

// ── Build from source (legacy) ───────────────────────────────────────────────

async function buildFromSource() {
  // Check flutter
  try {
    execSync("which flutter", { stdio: "pipe" });
  } catch {
    fail("flutter not found. Install it: https://docs.flutter.dev/get-started/install");
  }

  const flutterVer = execSync("flutter --version 2>&1", { encoding: "utf-8" }).split("\n")[0];
  ok(`flutter: ${flutterVer}`);

  fs.mkdirSync(SINAIN_DIR, { recursive: true });

  // Clone or update
  if (fs.existsSync(path.join(REPO_DIR, ".git"))) {
    log("Updating existing overlay repo...");
    execSync("git pull --ff-only", { cwd: REPO_DIR, stdio: "inherit" });
    ok("Repository updated");
  } else {
    log("Cloning overlay (sparse checkout — only overlay/ directory)...");
    if (fs.existsSync(REPO_DIR)) {
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
    }
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse https://github.com/${REPO}.git "${REPO_DIR}"`,
      { stdio: "inherit" }
    );
    execSync("git sparse-checkout set overlay", { cwd: REPO_DIR, stdio: "inherit" });
    ok("Repository cloned");
  }

  // Build
  const overlayDir = path.join(REPO_DIR, "overlay");
  if (!fs.existsSync(path.join(overlayDir, "pubspec.yaml"))) {
    fail("overlay/pubspec.yaml not found — sparse checkout may have failed");
  }

  log("Installing Flutter dependencies...");
  execSync("flutter pub get", { cwd: overlayDir, stdio: "inherit" });

  const buildTarget = IS_WINDOWS ? "windows" : "macos";
  log(`Building overlay for ${buildTarget} (this may take a few minutes)...`);
  execSync(`flutter build ${buildTarget}`, { cwd: overlayDir, stdio: "inherit" });
  ok("Overlay built successfully");

  // Symlink ~/.sinain/overlay → the overlay source dir
  try {
    if (fs.existsSync(OVERLAY_LINK)) {
      fs.unlinkSync(OVERLAY_LINK);
    }
    fs.symlinkSync(overlayDir, OVERLAY_LINK);
    ok(`Symlinked: ${OVERLAY_LINK} → ${overlayDir}`);
  } catch (e) {
    log(`Overlay built at: ${overlayDir}`);
  }

  console.log(`
${GREEN}✓${RESET} Overlay setup complete!
  The overlay will auto-start with: ${BOLD}sinain start${RESET}
  Or run manually: cd ${overlayDir} && flutter run -d ${IS_WINDOWS ? "windows" : "macos"}
`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
