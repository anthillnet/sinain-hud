/**
 * Download Manager — resumable, integrity-checked, atomic model downloads.
 *
 * SEED-001 Phase 4. Drives model-weight downloads into ~/.sinain/models/ for
 * the first-run wizard (whisper model for T1/T2). Ollama models are pulled via
 * Ollama's own /api/pull, NOT this manager.
 *
 * STATUS: SCAFFOLD. The download/verify/atomic-install core below is a working
 * first implementation, but the manifest fetch + wizard wiring are marked TODO
 * and it is not yet called from anywhere. See docs/dmg-distribution-spec.md §5.
 *
 * Design (SPEC §5a):
 *   - Resumable:  HTTP Range requests; persists a `.part` file + byte offset.
 *   - Integrity:  SHA-256 verified against the hosted manifest before promotion.
 *   - Atomic:     download to `*.part` → verify → rename() into the final path,
 *                 so the canonical path never holds a half-written model.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log, warn } from "../log.js";

const TAG = "download";

/** One downloadable artifact, as listed in the hosted models manifest. */
export interface ModelManifestEntry {
  /** Stable identifier, e.g. "whisper-large-v3-turbo". */
  id: string;
  /** Absolute download URL. */
  url: string;
  /** Lowercase hex SHA-256 of the complete file. */
  sha256: string;
  /** Expected size in bytes (for progress + sanity check). */
  sizeBytes: number;
  /** Install tier this artifact belongs to. */
  tier: "T1" | "T2";
  /** Final on-disk path; `~` is expanded by the caller (see resolvePath). */
  destPath: string;
}

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  /** 0..1, or null when total size is unknown. */
  fraction: number | null;
}

export type ProgressHandler = (p: DownloadProgress) => void;

export class IntegrityError extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`integrity check failed for ${id}: expected ${expected}, got ${actual}`);
    this.name = "IntegrityError";
  }
}

/**
 * Download a single manifest entry with resume + integrity + atomic install.
 * Returns the final installed path on success; throws IntegrityError on a
 * checksum mismatch or Error on network/IO failure.
 */
export async function downloadModel(
  entry: ModelManifestEntry,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  const finalPath = entry.destPath;
  const partPath = `${finalPath}.part`;

  await mkdir(dirname(finalPath), { recursive: true });

  // If a complete, valid file already exists, skip the download.
  if (await fileMatches(finalPath, entry.sha256)) {
    log(TAG, `${entry.id}: already present and verified`);
    return finalPath;
  }

  // Resume from an existing partial download if present.
  let startByte = 0;
  try {
    startByte = (await stat(partPath)).size;
  } catch {
    startByte = 0; // no .part yet
  }

  const headers: Record<string, string> = {};
  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-`;
    log(TAG, `${entry.id}: resuming from ${startByte} bytes`);
  }

  const res = await fetch(entry.url, { headers, signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`${entry.id}: download failed — HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error(`${entry.id}: response had no body`);
  }

  // If the server ignored Range (200 instead of 206), restart from scratch.
  const append = res.status === 206 && startByte > 0;
  if (!append) startByte = 0;

  const total = entry.sizeBytes;
  let received = startByte;

  const fileStream = createWriteStream(partPath, { flags: append ? "a" : "w" });
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.({
      id: entry.id,
      receivedBytes: received,
      totalBytes: total,
      fraction: total > 0 ? Math.min(received / total, 1) : null,
    });
  });

  await pipeline(body, fileStream);

  // Verify the completed .part before promoting it.
  const actual = await sha256File(partPath);
  if (actual !== entry.sha256) {
    throw new IntegrityError(entry.id, entry.sha256, actual);
  }

  // Atomic install: rename is atomic within the same filesystem.
  await rename(partPath, finalPath);
  log(TAG, `${entry.id}: installed → ${finalPath}`);
  return finalPath;
}

/** SHA-256 of a file as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** True iff `path` exists and its SHA-256 equals `expectedSha256`. */
async function fileMatches(path: string, expectedSha256: string): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false;
  }
  try {
    return (await sha256File(path)) === expectedSha256;
  } catch {
    return false;
  }
}

/**
 * Fetch the hosted models manifest (GitHub Pages).
 *
 * TODO(Phase 4): point at the real manifest URL once GitHub Pages hosting is
 * set up (see docs/distribution/models-manifest.example.json for the schema),
 * and decide how the manifest is versioned against app releases (open Q7).
 */
export async function fetchManifest(_manifestUrl: string): Promise<ModelManifestEntry[]> {
  throw new Error(
    "fetchManifest not implemented — SEED-001 Phase 4. See docs/dmg-distribution-spec.md §5a.",
  );
}

/**
 * Download every entry for a given tier, sequentially.
 *
 * TODO(Phase 5): wire this into the first-run wizard's tier-config step so the
 * whisper model downloads with a progress bar after the user picks T1/T2.
 */
export async function downloadForTier(
  entries: ModelManifestEntry[],
  tier: "T1" | "T2",
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<string[]> {
  const wanted = entries.filter((e) => e.tier === tier || (tier === "T2" && e.tier === "T1"));
  const installed: string[] = [];
  for (const entry of wanted) {
    try {
      installed.push(await downloadModel(entry, onProgress, signal));
    } catch (err) {
      warn(TAG, `failed to download ${entry.id}:`, err);
      throw err;
    }
  }
  return installed;
}
