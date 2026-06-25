#!/usr/bin/env node
// sinain setup-frpc — provision the upstream frp client (frpc) used by the
// ChatGPT MCP tunnel. macOS-only (the Windows client is retired). Mirrors
// setup-sck-capture.js: version-pinned, checksum-verified, idempotent refresh.
// See docs/DESIGN-CHATGPT-MCP-TUNNEL.md §3.5.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const SINAIN_DIR = path.join(HOME, ".sinain");
const BIN_DIR = path.join(SINAIN_DIR, "bin");
const BINARY_PATH = path.join(BIN_DIR, "frpc");
const VERSION_FILE = path.join(BIN_DIR, "frpc.version.json");

// Pinned frp release. Bump deliberately; the checksums file from the same
// release is fetched and verified, so we don't hardcode per-asset hashes.
const FRP_VERSION = process.env.SINAIN_FRP_VERSION || "0.61.1";
const REPO = "fatedier/frp";

const BOLD = "\x1b[1m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";
function log(m)  { console.log(`${BOLD}[setup-frpc]${RESET} ${m}`); }
function ok(m)   { console.log(`${BOLD}[setup-frpc]${RESET} ${GREEN}✓${RESET} ${m}`); }
function warn(m) { console.log(`${BOLD}[setup-frpc]${RESET} ${YELLOW}⚠${RESET} ${m}`); }

const isMain = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], "file://").href
);

function frpArch() {
  const a = os.arch();
  if (a === "arm64") return "arm64";
  if (a === "x64") return "amd64";
  return null;
}

/** Provision frpc. Idempotent: a no-op when the pinned version is already in
 *  place. Returns the binary path on success, or null on skip/failure. */
export async function setupFrpc({ silent = false, forceUpdate = false } = {}) {
  const _log = silent ? () => {} : log;
  const _ok = silent ? () => {} : ok;

  if (os.platform() !== "darwin") { _log("frpc is macOS-only — skipping"); return null; }
  const arch = frpArch();
  if (!arch) { warn(`unsupported arch ${os.arch()} — skipping frpc`); return null; }

  // Up-to-date check
  if (!forceUpdate && fs.existsSync(BINARY_PATH) && fs.existsSync(VERSION_FILE)) {
    try {
      const v = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
      if (v.version === FRP_VERSION && v.arch === arch) return BINARY_PATH;
    } catch { /* re-provision */ }
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const base = `frp_${FRP_VERSION}_darwin_${arch}`;
  const tgz = `${base}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/v${FRP_VERSION}/${tgz}`;
  _log(`Downloading frpc ${FRP_VERSION} (${arch})...`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frpc-"));
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) { warn(`frpc download failed (${res.status}) — tunnel unavailable until next launch`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const tgzPath = path.join(tmp, tgz);
    fs.writeFileSync(tgzPath, buf);

    await verifyChecksum(tgzPath, tgz, _log);

    execSync(`tar -xzf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(tmp)}`);
    const extracted = path.join(tmp, base, "frpc");
    if (!fs.existsSync(extracted)) { warn("frpc missing from archive"); return null; }
    fs.copyFileSync(extracted, BINARY_PATH);
    fs.chmodSync(BINARY_PATH, 0o755);

    // Apple Silicon refuses to run unsigned binaries; ad-hoc sign + drop any
    // quarantine attr so frpc launches without a Gatekeeper prompt.
    try { execSync(`xattr -d com.apple.quarantine ${JSON.stringify(BINARY_PATH)}`, { stdio: "ignore" }); } catch { /* none */ }
    try { execSync(`codesign --force --sign - ${JSON.stringify(BINARY_PATH)}`, { stdio: "ignore" }); } catch (e) { warn(`ad-hoc codesign failed: ${e.message}`); }

    fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: FRP_VERSION, arch }, null, 2));
    _ok(`frpc ${FRP_VERSION} (${arch}) → ${BINARY_PATH}`);
    return BINARY_PATH;
  } catch (e) {
    warn(`frpc provisioning failed: ${e.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

// Verify the tarball against the release's published checksums file. Best-effort:
// if the file can't be fetched we warn and proceed (same posture as sck-capture).
async function verifyChecksum(tgzPath, assetName, _log) {
  const candidates = [
    `frp_sha256_checksums.txt`,
    `frp_${FRP_VERSION}_checksums.txt`,
    `frp_${FRP_VERSION}_sha256_checksums.txt`,
  ];
  for (const name of candidates) {
    try {
      const res = await fetch(`https://github.com/${REPO}/releases/download/v${FRP_VERSION}/${name}`, { redirect: "follow" });
      if (!res.ok) continue;
      const text = await res.text();
      const line = text.split("\n").find((l) => l.trim().endsWith(assetName));
      if (!line) continue;
      const want = line.trim().split(/\s+/)[0].toLowerCase();
      const { createHash } = await import("node:crypto");
      const got = createHash("sha256").update(fs.readFileSync(tgzPath)).digest("hex");
      if (got !== want) throw new Error(`frpc checksum mismatch (want ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
      _log("frpc checksum verified");
      return;
    } catch (e) {
      if (/mismatch/.test(e.message)) throw e; // a real mismatch is fatal
    }
  }
  warn("frpc checksum file unavailable — proceeding without integrity check");
}

if (isMain) {
  const forceUpdate = process.argv.slice(2).includes("--update");
  await setupFrpc({ forceUpdate });
}
