#!/usr/bin/env node
// sinain setup-embedding — pre-cache sentence-transformer model at setup time
//
// Moves the ~90MB Xenova/all-MiniLM-L6-v2 download from sinain-core's
// first-startup to install time, keeping runtime fully offline in paranoid mode.
// Mirrors the style of setup-overlay.js / setup-sck-capture.js.

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const HOME = os.homedir();
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// sinain-core's node_modules contains @huggingface/transformers — load from there
// so we use the SAME package instance (and thus the same cache key) as runtime.
const PKG_DIR = path.dirname(new URL(import.meta.url).pathname);
const CORE_DIR = path.join(PKG_DIR, "sinain-core");

const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

function log(msg)  { console.log(`${BOLD}[setup-embedding]${RESET} ${msg}`); }
function ok(msg)   { console.log(`${BOLD}[setup-embedding]${RESET} ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${BOLD}[setup-embedding]${RESET} ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.error(`${BOLD}[setup-embedding]${RESET} ${RED}✗${RESET} ${msg}`); process.exit(1); }

// ── Entry point (only when run directly, not when imported) ──────────────────

const isMain = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], "file://").href
);

if (isMain) {
  const args = process.argv.slice(2);
  const forceUpdate = args.includes("--update");
  await cacheEmbeddingModel({ forceUpdate });
}

// ── Resolve cache directory (matches @huggingface/transformers default) ──────
//
// @huggingface/transformers stores models under:
//   $TRANSFORMERS_CACHE  OR
//   $HF_HOME/hub         OR
//   ~/.cache/huggingface/hub/
//
// We use the same resolution order so setup and runtime share the same cache.

function resolveHfCacheDir() {
  if (process.env.TRANSFORMERS_CACHE) return process.env.TRANSFORMERS_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, "hub");
  return path.join(HOME, ".cache", "huggingface", "hub");
}

// Model files land at: <cacheDir>/models--<org>--<name>/snapshots/**
// A snapshot directory means the model was cached successfully.

function isModelCached() {
  const cacheDir = resolveHfCacheDir();
  // Convert "Xenova/all-MiniLM-L6-v2" → "models--Xenova--all-MiniLM-L6-v2"
  const modelFolder = `models--${MODEL_ID.replace("/", "--")}`;
  const snapshotsDir = path.join(cacheDir, modelFolder, "snapshots");
  if (!fs.existsSync(snapshotsDir)) return false;
  // At least one snapshot sub-directory must exist and not be empty
  try {
    const snapshots = fs.readdirSync(snapshotsDir);
    return snapshots.length > 0;
  } catch {
    return false;
  }
}

// ── Download / cache the model ───────────────────────────────────────────────

export async function cacheEmbeddingModel({ silent = false, forceUpdate = false } = {}) {
  const _log = silent ? () => {} : log;
  const _ok  = silent ? () => {} : ok;
  const _warn = silent ? () => {} : warn;

  // Skip if already cached and not forcing update
  if (!forceUpdate && isModelCached()) {
    _ok(`Embedding model already cached (${MODEL_ID})`);
    return true;
  }

  if (forceUpdate && isModelCached()) {
    _log("Force update requested — re-downloading model...");
  }

  // Verify sinain-core's node_modules are present (installDeps runs first in launcher)
  const transformersPath = path.join(CORE_DIR, "node_modules", "@huggingface", "transformers");
  if (!fs.existsSync(transformersPath)) {
    const msg = `sinain-core/node_modules not found at ${CORE_DIR}.\n` +
      `  Run 'npm install' in sinain-core/ first, or let 'sinain start' handle it.`;
    if (silent) { _warn(msg); return false; }
    fail(msg);
  }

  _log(`Downloading sentence-transformer model (~90MB): ${MODEL_ID}`);
  _log("This may take 30-60 seconds on a slow connection...");

  const cacheDir = resolveHfCacheDir();
  _log(`${DIM}Cache location: ${cacheDir}${RESET}`);

  try {
    // Load @huggingface/transformers from sinain-core's node_modules
    // to guarantee the same module instance (and cache key) as the runtime.
    const require = createRequire(path.join(CORE_DIR, "package.json"));
    // Use dynamic import with the resolved path — createRequire gives us the path
    const transformersEntry = require.resolve("@huggingface/transformers");
    const { pipeline } = await import(transformersEntry);

    const start = Date.now();

    // Trigger the download by initialising the pipeline — identical call to
    // EmbeddingService.loadAsync() in sinain-core/src/embedding/service.ts.
    // When this resolves, the model is cached and subsequent calls (including
    // sinain-core startup) are cache-hits with no network activity.
    await pipeline("feature-extraction", MODEL_ID);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    _ok(`Embedding model cached in ${elapsed}s`);

    if (!silent) {
      const cacheDir = resolveHfCacheDir();
      console.log(`
${GREEN}✓${RESET} Embedding model ready!
  Model: ${MODEL_ID}
  Cache: ${cacheDir}
  sinain-core will load it from cache at startup (no network needed)
`);
    }
    return true;
  } catch (e) {
    const isNetworkError =
      e.message?.includes("fetch") ||
      e.message?.includes("network") ||
      e.message?.includes("ENOTFOUND") ||
      e.message?.includes("ECONNREFUSED") ||
      e.message?.includes("huggingface") ||
      e.code === "ENOTFOUND" ||
      e.code === "ECONNREFUSED";

    if (isNetworkError) {
      const networkMsg =
        `Failed to download embedding model from huggingface.co.\n` +
        `  Check network access. To skip and let runtime download (not recommended\n` +
        `  for paranoid mode), set SINAIN_SKIP_EMBEDDING_SETUP=1.`;
      if (silent) { _warn(networkMsg); return false; }
      fail(networkMsg);
    }

    const errorMsg = `Embedding model download failed: ${e.message?.slice(0, 200)}`;
    if (silent) { _warn(errorMsg); return false; }
    fail(errorMsg);
  }
}
