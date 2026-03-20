/**
 * sinain-knowledge — Git-backed snapshot store
 *
 * Manages a local git repository for periodic knowledge snapshots.
 * Each save overwrites snapshot.json and commits — git history IS the version history.
 *
 * Default location: ~/.sinain/knowledge-snapshots/
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { KnowledgeStore } from "./store.js";
import { exportSnapshot, importSnapshot, resolveTriplestorePath } from "./snapshot.js";
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

const TRIPLES_FILE = "triples.db";
const GITATTRIBUTES_FILE = ".gitattributes";

export class GitSnapshotStore {
  private repoPath: string;
  private logger: Logger;
  private remoteChecked = false;

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
      maxBuffer: 10 * 1024 * 1024, // 10 MB — snapshot.json can exceed default 1 MB
    }).trim();
  }

  private async ensureRepo(): Promise<void> {
    if (!existsSync(this.repoPath)) {
      mkdirSync(this.repoPath, { recursive: true });
    }

    const gitDir = join(this.repoPath, ".git");
    if (!existsSync(gitDir)) {
      this.git("init");
      this.git("config", "user.name", "sinain-knowledge");
      this.git("config", "user.email", "sinain@local");

      // Ensure binary handling for triplestore
      const gitattrsPath = join(this.repoPath, GITATTRIBUTES_FILE);
      if (!existsSync(gitattrsPath)) {
        writeFileSync(gitattrsPath, `${TRIPLES_FILE} binary\n`, "utf-8");
      }

      this.logger.info(`sinain-knowledge: initialized snapshot repo at ${this.repoPath}`);
    }

    await this.validateRemoteVisibility();
  }

  // ── Public repo guard ─────────────────────────────────────────────────

  private async validateRemoteVisibility(): Promise<void> {
    if (this.remoteChecked) return;

    let remotes: string;
    try {
      remotes = this.git("remote", "-v");
    } catch {
      this.remoteChecked = true;
      return; // no remotes
    }
    if (!remotes) { this.remoteChecked = true; return; }

    const githubPattern = /github\.com[:/]([^/]+)\/([^/.]+)/;
    const checked = new Set<string>();

    for (const line of remotes.split("\n")) {
      const match = line.match(githubPattern);
      if (!match) {
        // Non-GitHub remote — warn and skip
        const remoteName = line.split(/\s/)[0];
        if (remoteName && !line.includes("github.com")) {
          this.logger.warn(
            `sinain-knowledge: remote '${remoteName}' is not GitHub — skipping visibility check`,
          );
        }
        continue;
      }
      const [, owner, repo] = match;
      const key = `${owner}/${repo}`;
      if (checked.has(key)) continue; // deduplicate fetch/push lines
      checked.add(key);

      const remoteName = line.split(/\s/)[0];
      try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
        if (resp.ok) {
          const data = await resp.json() as { private: boolean };
          if (data.private === false) {
            throw new Error(
              `Refusing to save: remote '${remoteName}' points to public repo ${owner}/${repo}. ` +
              `Knowledge snapshots contain sensitive data and must only be stored in private repositories.`,
            );
          }
        }
        // 404 = private (or doesn't exist) → safe
      } catch (err) {
        // Re-throw our own Error, swallow network failures
        if (err instanceof Error && err.message.startsWith("Refusing to save")) throw err;
        this.logger.warn(
          `sinain-knowledge: could not check visibility of ${key}: ${String(err)}`,
        );
      }
    }

    this.remoteChecked = true;
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  /**
   * Export a snapshot from the store and commit it to the local git repo.
   * Returns the short commit hash.
   */
  async save(store: KnowledgeStore): Promise<string> {
    await this.ensureRepo();

    // Export snapshot WITHOUT triplestore (avoid loading GB of data into memory)
    const snapshot = exportSnapshot(store, { skipTriplestore: true });
    const snapshotPath = join(this.repoPath, SNAPSHOT_FILE);

    // Copy triplestore directly as binary — no base64 round-trip
    const srcDbPath = resolveTriplestorePath(store.getWorkspaceDir());
    const hasTriples = srcDbPath !== null;
    if (hasTriples) {
      copyFileSync(srcDbPath, join(this.repoPath, TRIPLES_FILE));
      const size = statSync(srcDbPath).size;
      (snapshot as any).triplestore = { dbFile: TRIPLES_FILE, sizeBytes: size };
    }

    // Write snapshot with stable key ordering for minimal diffs
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

    // Stage both files
    const filesToStage = [SNAPSHOT_FILE];
    if (hasTriples) filesToStage.push(TRIPLES_FILE);
    this.git("add", ...filesToStage);

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
    await this.push();
    return hash;
  }

  // ── Push ─────────────────────────────────────────────────────────────────

  private async push(): Promise<void> {
    try {
      const remotes = this.git("remote");
      if (!remotes) return;

      // Use a longer timeout for network operations
      execFileSync("git", ["push", "origin", "HEAD"], {
        cwd: this.repoPath,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: "pipe",
      });
      this.logger.info("sinain-knowledge: snapshot pushed to remote");
    } catch (err) {
      // Warn only if there IS a remote but push failed
      this.logger.warn(
        `sinain-knowledge: push failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      );
    }
  }

  // ── List ─────────────────────────────────────────────────────────────────

  /**
   * List recent snapshots from git log.
   * Returns an array of { hash, date, subject } objects.
   */
  async list(count = 20): Promise<Array<{ hash: string; date: string; subject: string }>> {
    await this.ensureRepo();

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
   * Reconstitutes triplestore base64 from separate binary file if needed.
   */
  async read(ref = "HEAD"): Promise<KnowledgeSnapshot> {
    await this.ensureRepo();
    const content = this.git("show", `${ref}:${SNAPSHOT_FILE}`);
    const snapshot = JSON.parse(content);

    // Reconstitute base64 from separate binary file (new format)
    if (snapshot.triplestore?.dbFile) {
      try {
        const dbBuf = execFileSync("git", ["show", `${ref}:${TRIPLES_FILE}`], {
          cwd: this.repoPath,
          timeout: 15_000,
          maxBuffer: 50 * 1024 * 1024, // 50 MB — triplestore can be large
        });
        snapshot.triplestore = { dbBase64: dbBuf.toString("base64") };
      } catch {
        // triples.db missing for this commit — treat as empty
        snapshot.triplestore = { dbBase64: "" };
      }
    }
    // Old format with inline dbBase64 — pass through unchanged

    return snapshot as KnowledgeSnapshot;
  }

  /**
   * Restore a snapshot from a git commit into the knowledge store.
   */
  async restore(store: KnowledgeStore, ref = "HEAD"): Promise<void> {
    const snapshot = await this.read(ref);
    importSnapshot(store, snapshot);
    this.logger.info(`sinain-knowledge: restored snapshot from ${ref}`);
  }

  // ── Diff ─────────────────────────────────────────────────────────────────

  /**
   * Show what changed between two snapshots (defaults to last two commits).
   */
  async diff(fromRef = "HEAD~1", toRef = "HEAD"): Promise<string> {
    await this.ensureRepo();
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
  async prune(maxSnapshots = MAX_SNAPSHOTS): Promise<void> {
    await this.ensureRepo();
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

  async getSnapshotCount(): Promise<number> {
    await this.ensureRepo();
    try {
      return parseInt(this.git("rev-list", "--count", "HEAD"), 10);
    } catch {
      return 0;
    }
  }
}
