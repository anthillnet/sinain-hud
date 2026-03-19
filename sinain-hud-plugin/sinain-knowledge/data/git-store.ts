/**
 * sinain-knowledge — Git-backed snapshot store
 *
 * Manages a local git repository for periodic knowledge snapshots.
 * Each save overwrites snapshot.json and commits — git history IS the version history.
 *
 * Default location: ~/.sinain/knowledge-snapshots/
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { KnowledgeStore } from "./store.js";
import { exportSnapshot, importSnapshot } from "./snapshot.js";
import type { KnowledgeSnapshot } from "./snapshot.js";
import type { Logger } from "./schema.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_REPO_PATH = join(homedir(), ".sinain", "knowledge-snapshots");
const SNAPSHOT_FILE = "snapshot.json";
const MAX_SNAPSHOTS = 100; // prune reflog beyond this

// ============================================================================
// GitSnapshotStore
// ============================================================================

export class GitSnapshotStore {
  private repoPath: string;
  private logger: Logger;

  constructor(repoPath?: string, logger?: Logger) {
    this.repoPath = resolve(repoPath ?? DEFAULT_REPO_PATH);
    this.logger = logger ?? { info: console.log, warn: console.warn };
  }

  // ── Git helpers ──────────────────────────────────────────────────────────

  private git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.repoPath,
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
  }

  private ensureRepo(): void {
    if (!existsSync(this.repoPath)) {
      mkdirSync(this.repoPath, { recursive: true });
    }

    const gitDir = join(this.repoPath, ".git");
    if (!existsSync(gitDir)) {
      this.git("init");
      this.git("config", "user.name", "sinain-knowledge");
      this.git("config", "user.email", "sinain@local");
      this.logger.info(`sinain-knowledge: initialized snapshot repo at ${this.repoPath}`);
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  /**
   * Export a snapshot from the store and commit it to the local git repo.
   * Returns the short commit hash.
   */
  save(store: KnowledgeStore): string {
    this.ensureRepo();

    const snapshot = exportSnapshot(store);
    const snapshotPath = join(this.repoPath, SNAPSHOT_FILE);

    // Write snapshot with stable key ordering for minimal diffs
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

    // Stage
    this.git("add", SNAPSHOT_FILE);

    // Check if there are staged changes
    try {
      this.git("diff", "--cached", "--quiet");
      // No changes — skip commit
      this.logger.info("sinain-knowledge: snapshot unchanged, skipping commit");
      return this.git("rev-parse", "--short", "HEAD");
    } catch {
      // diff --cached --quiet exits non-zero when there ARE changes — this is the expected path
    }

    // Build commit message
    const ts = snapshot.exportedAt;
    const playbookLines = snapshot.playbook.effective.split("\n").length;
    const moduleCount = snapshot.modules.items.length;
    const hasTriples = snapshot.triplestore.dbBase64.length > 0;

    const message = [
      `snapshot ${ts.slice(0, 19).replace("T", " ")}`,
      "",
      `Playbook: ${playbookLines} lines`,
      `Modules: ${moduleCount}`,
      `Triplestore: ${hasTriples ? "yes" : "empty"}`,
      `Source: ${snapshot.exportedFrom}`,
      `Integrity: ${snapshot.integrity.slice(0, 12)}…`,
    ].join("\n");

    this.git("commit", "-m", message);
    const hash = this.git("rev-parse", "--short", "HEAD");
    this.logger.info(`sinain-knowledge: snapshot saved → ${hash}`);
    return hash;
  }

  // ── List ─────────────────────────────────────────────────────────────────

  /**
   * List recent snapshots from git log.
   * Returns an array of { hash, date, subject } objects.
   */
  list(count = 20): Array<{ hash: string; date: string; subject: string }> {
    this.ensureRepo();

    try {
      const log = this.git(
        "log",
        `--max-count=${count}`,
        "--format=%h\t%ai\t%s",
      );
      if (!log) return [];

      return log.split("\n").map((line) => {
        const [hash, date, subject] = line.split("\t");
        return { hash, date, subject };
      });
    } catch {
      return []; // empty repo
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  /**
   * Read a snapshot from a specific git commit (or HEAD).
   */
  read(ref = "HEAD"): KnowledgeSnapshot {
    this.ensureRepo();
    const content = this.git("show", `${ref}:${SNAPSHOT_FILE}`);
    return JSON.parse(content) as KnowledgeSnapshot;
  }

  /**
   * Restore a snapshot from a git commit into the knowledge store.
   */
  restore(store: KnowledgeStore, ref = "HEAD"): void {
    const snapshot = this.read(ref);
    importSnapshot(store, snapshot);
    this.logger.info(`sinain-knowledge: restored snapshot from ${ref}`);
  }

  // ── Diff ─────────────────────────────────────────────────────────────────

  /**
   * Show what changed between two snapshots (defaults to last two commits).
   */
  diff(fromRef = "HEAD~1", toRef = "HEAD"): string {
    this.ensureRepo();
    try {
      return this.git("diff", "--stat", fromRef, toRef);
    } catch {
      return "(no diff available)";
    }
  }

  // ── Prune ────────────────────────────────────────────────────────────────

  /**
   * Prune old snapshots by squashing history beyond maxSnapshots.
   * Uses reflog expire + gc to reclaim space.
   */
  prune(maxSnapshots = MAX_SNAPSHOTS): void {
    this.ensureRepo();
    try {
      const count = parseInt(this.git("rev-list", "--count", "HEAD"), 10);
      if (count <= maxSnapshots) return;

      this.git("reflog", "expire", "--expire=now", "--all");
      this.git("gc", "--prune=now", "--quiet");
      this.logger.info(`sinain-knowledge: pruned snapshot repo (${count} commits, gc'd)`);
    } catch {
      // gc failure is non-critical
    }
  }

  // ── Info ──────────────────────────────────────────────────────────────────

  getRepoPath(): string {
    return this.repoPath;
  }

  getSnapshotCount(): number {
    this.ensureRepo();
    try {
      return parseInt(this.git("rev-list", "--count", "HEAD"), 10);
    } catch {
      return 0;
    }
  }
}
