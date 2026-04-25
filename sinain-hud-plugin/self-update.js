/**
 * Self-update sentinel for @geravant/sinain.
 *
 * Why this exists: when users run `npx @geravant/sinain start` (without a
 * version pin), npx caches the *unversioned spec* and reuses that cache
 * forever — never re-checking the registry. Users end up running 1.6.x
 * for months while the latest is 1.15+. The cache-key is the spec, not
 * the version, so once the slot is populated, `npx` considers the spec
 * "satisfied" indefinitely.
 *
 * Fix: at the top of cli.js, BEFORE any command dispatches, query the
 * npm registry for the current `latest` dist-tag. If it's newer than
 * the version of this file, re-exec ourselves with
 * `npx --ignore-existing @geravant/sinain@<latest> <argv>`. The user sees
 * one extra "updating..." line and then the up-to-date wizard runs.
 *
 * Cost: ~500ms startup latency (single HTTPS GET to registry.npmjs.org).
 * Soft-fail on network errors so offline use still works.
 *
 * Loop protection: SINAIN_SELF_UPDATED=1 is set on the relaunched process
 * so it can't recurse if the registry returns nonsense. Users can opt out
 * entirely with SINAIN_NO_AUTO_UPDATE=1.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "@geravant/sinain";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const FETCH_TIMEOUT_MS = 2000;

/**
 * Compare two semver versions. Returns >0 if a>b, <0 if a<b, 0 if equal.
 * Handles only X.Y.Z (no pre-release tags). Tolerates leading 'v'.
 */
function semverCompare(a, b) {
  const parse = (v) => v.replace(/^v/, "").split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return null;
  }
}

async function fetchRemoteVersion() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Commands that should NOT trigger a self-update check:
 *   - update    : explicit user action (already updating)
 *   - version   : status query, must be fast and offline-safe
 *   - help      : ditto
 *   - stop      : tearing things down, don't introduce a network call
 *   - status    : status query, fast + offline-safe
 *   - completion / shell helpers : trivial, must not block
 *
 * `start`, `setup-overlay`, `onboard`, `config` (i.e. anything that runs
 * the wizard or core install path) DO trigger the check, because that's
 * where stale-cache UX hits hardest.
 */
const SKIP_COMMANDS = new Set([
  "update", "version", "--version", "-v",
  "help", "--help", "-h",
  "stop", "status", "completion",
]);

/**
 * Run the self-update check. If a newer version is available, exec ourselves
 * via `npx --ignore-existing @geravant/sinain@<latest>` and exit with the
 * relaunched process's status. If everything's fine (or the check fails
 * soft), this function returns and the caller proceeds normally.
 */
export async function checkForUpdate() {
  // Loop guard — set on the relaunched process so we can't recurse.
  if (process.env.SINAIN_SELF_UPDATED === "1") return;
  // Opt-out for users who don't want the network call.
  if (process.env.SINAIN_NO_AUTO_UPDATE === "1") return;
  // Skip commands that shouldn't pay the network cost.
  const cmd = process.argv[2];
  if (cmd && SKIP_COMMANDS.has(cmd)) return;

  const local = readLocalVersion();
  if (!local) return;

  const remote = await fetchRemoteVersion();
  if (!remote) return;

  if (semverCompare(remote, local) <= 0) return;

  // Stale — print + relaunch.
  process.stderr.write(
    `\n  ⚠ sinain ${local} is stale; latest is ${remote}\n` +
    `  Auto-updating... (set SINAIN_NO_AUTO_UPDATE=1 to disable)\n\n`,
  );

  const args = process.argv.slice(2);
  // --yes: skip npx's "are you sure" prompt for unfamiliar packages.
  // (Note: do NOT pass --ignore-existing — npm 7+ removed it. The
  //  version-pinned spec `@geravant/sinain@<remote>` already keys to a
  //  separate npx cache slot, so a fresh `<remote>` triggers a download
  //  regardless of what's in the unversioned slot.)
  const result = spawnSync(
    "npx",
    ["--yes", `${PKG_NAME}@${remote}`, ...args],
    {
      stdio: "inherit",
      env: { ...process.env, SINAIN_SELF_UPDATED: "1" },
    },
  );
  process.exit(result.status ?? 1);
}
