import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log, error } from "../log.js";

const TAG = "task-store";

/**
 * Persistent task entry for spawn tasks.
 */
export interface PendingTaskEntry {
  runId: string;
  childSessionKey: string;
  label?: string;
  startedAt: number;
  pollingEmitted: boolean;
}

const STORE_DIR = path.join(os.homedir(), ".sinain-core");
const STORE_PATH = path.join(STORE_DIR, "pending-tasks.json");

/**
 * Load pending tasks from disk.
 * Returns empty map if file doesn't exist or is corrupted.
 */
export function loadPendingTasks(): Map<string, PendingTaskEntry> {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return new Map();
    }
    const data = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      return new Map();
    }
    const map = new Map<string, PendingTaskEntry>();
    for (const [key, value] of parsed) {
      if (typeof key === "string" && value && typeof value.runId === "string") {
        map.set(key, value as PendingTaskEntry);
      }
    }
    log(TAG, `loaded ${map.size} pending task(s) from disk`);
    return map;
  } catch (err: any) {
    error(TAG, `failed to load pending tasks: ${err.message}`);
    return new Map();
  }
}

/**
 * Save pending tasks to disk atomically.
 * Uses write-then-rename for crash safety.
 */
export function savePendingTasks(tasks: Map<string, PendingTaskEntry>): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(STORE_DIR)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
    }

    // Convert map to array of entries for JSON serialization
    const entries = Array.from(tasks.entries());
    const tmpPath = STORE_PATH + ".tmp";

    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf-8");
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (err: any) {
    error(TAG, `failed to save pending tasks: ${err.message}`);
  }
}

/**
 * Delete the task store file (cleanup).
 */
export function clearPendingTasks(): void {
  try {
    if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
      log(TAG, "cleared pending tasks file");
    }
  } catch (err: any) {
    error(TAG, `failed to clear pending tasks: ${err.message}`);
  }
}
