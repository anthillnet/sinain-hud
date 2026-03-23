#!/usr/bin/env node
// sinain setup-sck-capture — download pre-built sck-capture binary from GitHub Releases

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const INSTALL_DIR = path.join(SINAIN_DIR, "sck-capture");
const BINARY_PATH = path.join(INSTALL_DIR, "sck-capture");
const VERSION_FILE = path.join(INSTALL_DIR, "version.json");

const REPO = "anthillnet/sinain-hud";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
const TAG_PREFIX = "sck-capture-v";
const ASSET_NAME = "sck-capture-macos.zip";

const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg)  { console.log(`${BOLD}[setup-sck-capture]${RESET} ${msg}`); }
function ok(msg)   { console.log(`${BOLD}[setup-sck-capture]${RESET} ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${BOLD}[setup-sck-capture]${RESET} ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.error(`${BOLD}[setup-sck-capture]${RESET} ${RED}✗${RESET} ${msg}`); process.exit(1); }

// ── Entry point (only when run directly, not when imported) ──────────────────

const isMain = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], "file://").href
);

if (isMain) {
  const args = process.argv.slice(2);
  const forceUpdate = args.includes("--update");

  if (os.platform() === "win32") {
    log("sck-capture is macOS-only (Windows uses win-audio-capture.exe)");
    process.exit(0);
  }

  await downloadBinary({ forceUpdate });
}

// ── Download pre-built binary ────────────────────────────────────────────────

export async function downloadBinary({ silent = false, forceUpdate = false } = {}) {
  const _log = silent ? () => {} : log;
  const _ok = silent ? () => {} : ok;
  const _warn = silent ? () => {} : warn;

  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // Find latest sck-capture release
  _log("Checking for latest sck-capture release...");
  let release;
  try {
    const res = await fetch(`${RELEASES_API}?per_page=30`, {
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const releases = await res.json();
    release = releases.find(r => r.tag_name?.startsWith(TAG_PREFIX));
    if (!release) throw new Error("No sck-capture release found");
  } catch (e) {
    if (silent) {
      _warn(`Failed to fetch sck-capture release: ${e.message}`);
      return false;
    }
    fail(`Failed to fetch releases: ${e.message}`);
  }

  const tag = release.tag_name;
  const version = tag.replace(TAG_PREFIX, "");

  // Check if already up-to-date
  if (!forceUpdate && fs.existsSync(VERSION_FILE) && fs.existsSync(BINARY_PATH)) {
    try {
      const local = JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
      if (local.tag === tag) {
        _ok(`sck-capture already up-to-date (${version})`);
        return true;
      }
      _log(`Updating: ${local.tag} → ${tag}`);
    } catch { /* corrupt version file — re-download */ }
  }

  // Find the .zip asset
  const zipAsset = release.assets?.find(a => a.name === ASSET_NAME);
  if (!zipAsset) {
    if (silent) {
      _warn(`Release ${tag} has no ${ASSET_NAME} asset`);
      return false;
    }
    fail(`Release ${tag} has no ${ASSET_NAME} asset`);
  }

  // Download
  _log(`Downloading sck-capture ${version} (${formatBytes(zipAsset.size)})...`);
  const zipPath = path.join(INSTALL_DIR, ASSET_NAME);

  try {
    const res = await fetch(zipAsset.browser_download_url, {
      signal: AbortSignal.timeout(60000),
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
      if (!silent && total > 0) {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\r${BOLD}[setup-sck-capture]${RESET} ${DIM}${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})${RESET}`);
      }
    }
    if (!silent) process.stdout.write("\n");

    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(zipPath, buffer);
    _ok(`Downloaded ${formatBytes(buffer.length)}`);
  } catch (e) {
    if (silent) {
      _warn(`Download failed: ${e.message}`);
      return false;
    }
    fail(`Download failed: ${e.message}`);
  }

  // Remove old binary if present
  if (fs.existsSync(BINARY_PATH)) {
    fs.unlinkSync(BINARY_PATH);
  }

  // Extract
  _log("Extracting...");
  try {
    execSync(`ditto -x -k "${zipPath}" "${INSTALL_DIR}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`unzip -o -q "${zipPath}" -d "${INSTALL_DIR}"`, { stdio: "pipe" });
    } catch (e) {
      if (silent) {
        _warn(`Extraction failed: ${e.message}`);
        return false;
      }
      fail(`Extraction failed: ${e.message}`);
    }
  }

  // Make executable
  try {
    fs.chmodSync(BINARY_PATH, 0o755);
  } catch { /* may not exist if zip structure differs */ }

  // Write version marker
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    tag,
    version,
    installedAt: new Date().toISOString(),
  }, null, 2));

  // Clean up zip
  fs.unlinkSync(zipPath);

  _ok(`sck-capture ${version} installed → ${BINARY_PATH}`);
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
