#!/usr/bin/env node
// sinain setup-overlay — clone and build the Flutter overlay app

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const REPO_DIR = path.join(SINAIN_DIR, "overlay-repo");
const OVERLAY_LINK = path.join(SINAIN_DIR, "overlay");

const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";

function log(msg) { console.log(`${BOLD}[setup-overlay]${RESET} ${msg}`); }
function ok(msg)  { console.log(`${BOLD}[setup-overlay]${RESET} ${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.error(`${BOLD}[setup-overlay]${RESET} ${RED}✗${RESET} ${msg}`); process.exit(1); }

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
    `git clone --depth 1 --filter=blob:none --sparse https://github.com/anthillnet/sinain-hud.git "${REPO_DIR}"`,
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

log("Building overlay (this may take a few minutes)...");
execSync("flutter build macos", { cwd: overlayDir, stdio: "inherit" });
ok("Overlay built successfully");

// Symlink ~/.sinain/overlay → the overlay source dir
try {
  if (fs.existsSync(OVERLAY_LINK)) {
    fs.unlinkSync(OVERLAY_LINK);
  }
  fs.symlinkSync(overlayDir, OVERLAY_LINK);
  ok(`Symlinked: ${OVERLAY_LINK} → ${overlayDir}`);
} catch (e) {
  // Symlink may fail on some systems — fall back to just noting the path
  log(`Overlay built at: ${overlayDir}`);
}

console.log(`
${GREEN}✓${RESET} Overlay setup complete!
  The overlay will auto-start with: ${BOLD}sinain start${RESET}
  Or run manually: cd ${overlayDir} && flutter run -d macos
`);
