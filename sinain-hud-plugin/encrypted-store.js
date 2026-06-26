// Opt-in app-managed encryption for the on-device data dir (Layer 4, Option B).
//
// Puts ~/.sinain/memory on an encrypted APFS sparse disk image whose passphrase
// lives only in the macOS Keychain. This encrypts EVERY store under memory/
// uniformly — including the Oxigraph (RocksDB) knowledge graph, which has no
// app-layer encryption of its own — without touching any store code.
//
// Enabled with SINAIN_ENCRYPTED_STORE=true. Default OFF → every export here is a
// no-op, so this file has zero effect until a user opts in. macOS-only.
//
// SECURITY POSTURE
//  - Fail CLOSED: if encryption is enabled but the volume can't be mounted, we
//    throw so the launcher aborts rather than silently writing plaintext.
//  - The passphrase is fed to hdiutil via stdin (never argv) and stored in the
//    login Keychain (not on disk).
//  - Migration of an existing plaintext memory/ is copy → verify → KEEP a
//    timestamped plaintext backup (we never auto-delete user data in this
//    not-yet-hardware-tested path); the user removes the backup once satisfied.
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const MEMORY_DIR = process.env.SINAIN_MEMORY_DIR || path.join(SINAIN_DIR, "memory");
const IMAGE_PATH = path.join(SINAIN_DIR, "memory.sparseimage");
const VOLNAME = "SinainMemory";
const IMAGE_SIZE = process.env.SINAIN_ENCRYPTED_STORE_SIZE || "30g"; // sparse — only consumes what's used
const KC_SERVICE = "sinain-encrypted-store";
const KC_ACCOUNT = os.userInfo().username;

const ENABLED = process.env.SINAIN_ENCRYPTED_STORE === "true";
const IS_MAC = os.platform() === "darwin";
const C = { Y: "\x1b[33m", G: "\x1b[32m", R: "\x1b[31m", D: "\x1b[2m", B: "\x1b[1m", X: "\x1b[0m" };

export function isEnabled() { return ENABLED; }

// ── Keychain (passphrase store) ──────────────────────────────────────────────
function keychainGet() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }
}
function keychainSet(secret) {
  // -U updates if present. (The secret is on argv here — a brief, local-only
  // exposure; acceptable for a one-time create. Retrieval uses stdout, not argv.)
  execFileSync("security", ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w", secret],
    { stdio: ["pipe", "pipe", "pipe"] });
}
function getOrCreateKey() {
  let key = keychainGet();
  if (!key) {
    key = crypto.randomBytes(32).toString("base64");
    keychainSet(key);
    console.log(`  ${C.G}✓${C.X} generated encryption key (stored in your login Keychain: ${C.D}${KC_SERVICE}${C.X})`);
  }
  return key;
}

// ── hdiutil helpers (passphrase via stdin, never argv) ───────────────────────
function hdiutil(args, key) {
  return execFileSync("hdiutil", args, { input: key, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}
function imageExists() { return fs.existsSync(IMAGE_PATH); }
function isMounted() {
  try {
    const info = execFileSync("hdiutil", ["info"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return info.includes(MEMORY_DIR) || info.includes(IMAGE_PATH);
  } catch { return false; }
}
function createImage(key) {
  hdiutil(["create", "-size", IMAGE_SIZE, "-type", "SPARSE", "-fs", "APFS",
    "-volname", VOLNAME, "-encryption", "AES-256", "-stdinpass", IMAGE_PATH], key);
}
function attach(key) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
  hdiutil(["attach", IMAGE_PATH, "-stdinpass", "-mountpoint", MEMORY_DIR, "-nobrowse", "-owners", "on"], key);
}

/** Detach the encrypted volume. Best-effort; tries a forced detach on failure. */
export function detach() {
  if (!ENABLED || !IS_MAC) return;
  if (!isMounted()) return;
  try { execFileSync("hdiutil", ["detach", MEMORY_DIR], { stdio: ["pipe", "pipe", "pipe"] }); return; }
  catch { /* try force */ }
  try { execFileSync("hdiutil", ["detach", MEMORY_DIR, "-force"], { stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { console.error(`  ${C.Y}⚠${C.X} could not detach encrypted store: ${e.message}`); }
}

/** Destroy the encrypted volume + Keychain key (called by `sinain wipe`). */
export function destroy() {
  if (!IS_MAC) return;
  detach();
  try { if (imageExists()) fs.rmSync(IMAGE_PATH, { force: true }); } catch { /* ignore */ }
  try { execFileSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT], { stdio: ["pipe", "pipe", "pipe"] }); }
  catch { /* no key — fine */ }
}

// ── First-run migration of an existing plaintext memory/ ─────────────────────
function dirHasContent(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch { return false; }
}
function treeStats(p) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { bytes += fs.statSync(full).size; files++; } catch { /* skip */ } }
    }
  };
  try { walk(p); } catch { /* ignore */ }
  return { files, bytes };
}
// Conservative restore: only safe to run when the volume is NOT mounted (so we
// never delete into a live encrypted volume). Leaves the backup in place if it
// can't restore cleanly — data is never destroyed, only ever instructed about.
function safeRestore(backup) {
  if (isMounted()) return false;                  // refuse to touch a mounted dir
  try { if (imageExists()) fs.rmSync(IMAGE_PATH, { force: true }); } catch { /* ignore */ }
  try {
    if (fs.existsSync(MEMORY_DIR)) fs.rmdirSync(MEMORY_DIR); // empty mountpoint only (rmdir, not recursive)
    fs.renameSync(backup, MEMORY_DIR);
    return true;
  } catch { return false; }
}

function migratePlaintext(key) {
  const backup = `${MEMORY_DIR}.plaintext-bak`;
  if (fs.existsSync(backup)) throw new Error(`migration backup already exists at ${backup} — resolve it manually before enabling`);
  console.log(`  ${C.Y}→${C.X} migrating existing plaintext memory/ into the encrypted store…`);
  const before = treeStats(MEMORY_DIR);

  // Move existing plaintext aside, mount a fresh encrypted volume at MEMORY_DIR,
  // copy the data back in, then verify before declaring success. The backup is
  // NEVER auto-deleted in this path — worst case the data sits safely in it.
  fs.renameSync(MEMORY_DIR, backup);
  try {
    createImage(key);
    attach(key);
    execFileSync("ditto", [backup, MEMORY_DIR], { stdio: ["pipe", "pipe", "pipe"] }); // preserves perms/xattrs
  } catch (e) {
    detach();
    const restored = safeRestore(backup);
    throw new Error(`encrypted-store migration failed${restored ? " (plaintext restored)" : ` — your data is safe at ${backup}`}: ${e.message}`);
  }

  const after = treeStats(MEMORY_DIR);
  if (after.files < before.files || after.bytes < before.bytes) {
    detach();
    const restored = safeRestore(backup);
    throw new Error(`encrypted-store migration verify failed (${after.files}/${before.files} files)${restored ? " — plaintext restored" : ` — your data is safe at ${backup}`}`);
  }

  console.log(`  ${C.G}✓${C.X} migrated ${after.files} files into the encrypted store`);
  console.log(`  ${C.Y}⚠ a PLAINTEXT backup remains at ${backup.replace(HOME, "~")}${C.X}`);
  console.log(`  ${C.D}    delete it once you've confirmed the encrypted store works:  rm -rf "${backup}"${C.X}`);
}

/**
 * Ensure the encrypted store is mounted at MEMORY_DIR before sinain-core starts.
 * No-op unless SINAIN_ENCRYPTED_STORE=true. Fail-closed: throws if enabled but
 * the volume can't be prepared (so the launcher aborts rather than writing
 * plaintext). Call this BEFORE spawning sinain-core.
 */
export function ensureMounted() {
  if (!ENABLED) return;
  if (!IS_MAC) {
    console.error(`  ${C.R}✗${C.X} SINAIN_ENCRYPTED_STORE is macOS-only.`);
    throw new Error("encrypted store requested on a non-macOS platform");
  }
  if (isMounted()) { console.log(`  ${C.G}✓${C.X} encrypted store mounted`); return; }

  const key = getOrCreateKey();
  if (imageExists()) {
    attach(key);
  } else if (dirHasContent(MEMORY_DIR)) {
    migratePlaintext(key);
  } else {
    try { if (fs.existsSync(MEMORY_DIR)) fs.rmdirSync(MEMORY_DIR); } catch { /* non-empty? leave */ }
    createImage(key);
    attach(key);
    console.log(`  ${C.G}✓${C.X} created encrypted store at ${MEMORY_DIR.replace(HOME, "~")}`);
  }

  if (!isMounted()) throw new Error("encrypted store failed to mount (fail-closed; not writing plaintext)");
}
