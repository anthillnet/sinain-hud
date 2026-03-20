/**
 * sinain-knowledge — KnowledgeStore
 *
 * Wraps all file I/O for the knowledge system: workspace setup, file deployment,
 * playbook management, module guidance, session summaries, eval logs, and SITUATION.md.
 *
 * Pure Node.js built-in imports only — no OpenClaw dependency.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { join, dirname, extname } from "node:path";

import type { Logger, ModuleRegistry } from "./schema.js";

// ============================================================================
// KnowledgeStore
// ============================================================================

export class KnowledgeStore {
  constructor(
    private workspaceDir: string,
    private logger: Logger,
  ) {}

  /** Update the workspace directory (e.g. after before_agent_start provides it). */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir;
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  // ── Workspace setup ─────────────────────────────────────────────────────

  /** Ensure all memory sub-directories exist and are writable. */
  ensureMemoryDirs(): void {
    for (const dir of [
      "memory",
      "memory/playbook-archive",
      "memory/playbook-logs",
      "memory/eval-logs",
      "memory/eval-reports",
    ]) {
      const fullPath = join(this.workspaceDir, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
      try {
        chmodSync(fullPath, 0o755);
      } catch {
        // Best-effort — may fail if owned by another user
      }
    }
  }

  // ── File deployment ─────────────────────────────────────────────────────

  /**
   * Sync a single source file to the workspace, writing only if content changed.
   * Returns true if the file was written.
   */
  deployFile(sourcePath: string | undefined, targetName: string): boolean {
    if (!sourcePath) return false;

    try {
      const content = readFileSync(sourcePath, "utf-8");
      const targetPath = join(this.workspaceDir, targetName);
      const targetDir = dirname(targetPath);

      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      let existing = "";
      try {
        existing = readFileSync(targetPath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      if (existing !== content) {
        writeFileSync(targetPath, content, "utf-8");
        this.logger.info(`sinain-hud: synced ${targetName} to workspace`);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(`sinain-hud: failed to sync ${targetName}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Recursively sync a source directory to the workspace with selective overwrite policy:
   * - .json, .sh, .txt, .jsonl, .py — always overwritten (infra/config files we control)
   * - others — deploy-once only (skip if already exists; bot owns these after first deploy)
   * Skips __pycache__ and hidden directories.
   */
  deployDir(sourceDir: string, targetDirName: string): number {
    if (!existsSync(sourceDir)) return 0;
    const targetDir = join(this.workspaceDir, targetDirName);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const ALWAYS_OVERWRITE = new Set([".json", ".sh", ".txt", ".jsonl", ".py"]);
    let synced = 0;

    const syncRecursive = (srcDir: string, dstDir: string): void => {
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
      for (const entry of readdirSync(srcDir)) {
        const srcPath = join(srcDir, entry);
        const dstPath = join(dstDir, entry);
        const stat = statSync(srcPath);
        if (stat.isDirectory()) {
          if (entry.startsWith("__") || entry.startsWith(".")) continue;
          syncRecursive(srcPath, dstPath);
          continue;
        }
        if (!stat.isFile()) continue;
        const ext = extname(entry).toLowerCase();
        if (!ALWAYS_OVERWRITE.has(ext) && existsSync(dstPath)) continue;
        const content = readFileSync(srcPath, "utf-8");
        let existing = "";
        try {
          existing = readFileSync(dstPath, "utf-8");
        } catch {}
        if (existing !== content) {
          writeFileSync(dstPath, content, "utf-8");
          synced++;
        }
      }
    };

    syncRecursive(sourceDir, targetDir);
    if (synced > 0) this.logger.info(`sinain-hud: synced ${synced} files to ${targetDirName}/`);
    return synced;
  }

  /**
   * Recursively sync a modules/ source directory to workspace with selective deploy policy:
   * - manifest.json → always overwrite (plugin controls schema)
   * - module-registry.json, patterns.md, guidance.md → deploy-once (agent manages)
   * - context/*.json → always overwrite
   */
  deployModules(sourceDir: string): number {
    if (!existsSync(sourceDir)) return 0;
    const targetDir = join(this.workspaceDir, "modules");
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const ALWAYS_OVERWRITE = new Set(["manifest.json"]);
    const DEPLOY_ONCE = new Set(["module-registry.json", "patterns.md", "guidance.md"]);
    let synced = 0;

    const syncRecursive = (srcDir: string, dstDir: string): void => {
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

      for (const entry of readdirSync(srcDir)) {
        const srcPath = join(srcDir, entry);
        const dstPath = join(dstDir, entry);
        const stat = statSync(srcPath);

        if (stat.isDirectory()) {
          syncRecursive(srcPath, dstPath);
          continue;
        }

        if (!stat.isFile()) continue;

        const fileName = entry;
        const isAlwaysOverwrite = ALWAYS_OVERWRITE.has(fileName) || fileName.startsWith("context/");
        const isDeployOnce = DEPLOY_ONCE.has(fileName);

        if (isDeployOnce && existsSync(dstPath)) continue;
        if (!isAlwaysOverwrite && !isDeployOnce && existsSync(dstPath)) continue;

        const content = readFileSync(srcPath, "utf-8");
        let existing = "";
        try {
          existing = readFileSync(dstPath, "utf-8");
        } catch {}
        if (existing !== content) {
          writeFileSync(dstPath, content, "utf-8");
          synced++;
        }
      }
    };

    syncRecursive(sourceDir, targetDir);
    if (synced > 0) this.logger.info(`sinain-hud: synced ${synced} module files to modules/`);
    return synced;
  }

  // ── Playbook ────────────────────────────────────────────────────────────

  readPlaybook(): string | null {
    const p = join(this.workspaceDir, "memory", "sinain-playbook.md");
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  writePlaybook(content: string): void {
    const dir = join(this.workspaceDir, "memory");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sinain-playbook.md"), content, "utf-8");
  }

  readEffectivePlaybook(): string | null {
    const p = join(this.workspaceDir, "memory", "sinain-playbook-effective.md");
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Generate the merged effective playbook from active modules + base playbook.
   * Reads module-registry.json, collects patterns.md from each active module
   * (sorted by priority desc), reads the base sinain-playbook.md, and writes
   * the merged result to memory/sinain-playbook-effective.md.
   */
  generateEffectivePlaybook(): boolean {
    const registryPath = join(this.workspaceDir, "modules", "module-registry.json");
    if (!existsSync(registryPath)) {
      this.logger.info("sinain-hud: no module-registry.json found, skipping effective playbook generation");
      return false;
    }

    let registry: ModuleRegistry;
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf-8")) as ModuleRegistry;
    } catch (err) {
      this.logger.warn(`sinain-hud: failed to parse module-registry.json: ${String(err)}`);
      return false;
    }

    // Collect active modules sorted by priority desc
    const activeModules: Array<{ id: string; priority: number }> = [];
    for (const [id, entry] of Object.entries(registry.modules)) {
      if (entry.status === "active") {
        activeModules.push({ id, priority: entry.priority });
      }
    }
    activeModules.sort((a, b) => b.priority - a.priority);

    // Build module stack header
    const stackLabel = activeModules.map((m) => `${m.id}(${m.priority})`).join(", ");

    // Collect patterns from each active module
    const sections: string[] = [];
    sections.push(`<!-- module-stack: ${stackLabel} -->`);
    sections.push("");

    for (const mod of activeModules) {
      const patternsPath = join(this.workspaceDir, "modules", mod.id, "patterns.md");
      if (!existsSync(patternsPath)) continue;
      try {
        const patterns = readFileSync(patternsPath, "utf-8").trim();
        if (patterns) {
          sections.push(`<!-- module: ${mod.id} (priority ${mod.priority}) -->`);
          const manifestPath = join(this.workspaceDir, "modules", mod.id, "manifest.json");
          if (existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
              if (manifest.importedAt) {
                sections.push(`> *[Transferred knowledge: ${manifest.name || mod.id}]*`);
              }
            } catch {}
          }
          sections.push(patterns);
          sections.push("");
        }
      } catch {
        // Skip unreadable patterns
      }
    }

    // Append base playbook
    const basePlaybookPath = join(this.workspaceDir, "memory", "sinain-playbook.md");
    if (existsSync(basePlaybookPath)) {
      try {
        const base = readFileSync(basePlaybookPath, "utf-8").trim();
        if (base) {
          sections.push("<!-- base-playbook -->");
          sections.push(base);
          sections.push("");
        }
      } catch {}
    }

    // Write effective playbook (always overwrite)
    const effectivePath = join(this.workspaceDir, "memory", "sinain-playbook-effective.md");
    const effectiveDir = dirname(effectivePath);
    if (!existsSync(effectiveDir)) mkdirSync(effectiveDir, { recursive: true });

    const content = sections.join("\n");
    writeFileSync(effectivePath, content, "utf-8");
    this.logger.info(`sinain-hud: generated effective playbook (${activeModules.length} active modules)`);
    return true;
  }

  /**
   * Update the effectiveness footer in the base playbook with fresh metrics.
   */
  updateEffectivenessFooter(effectiveness: Record<string, unknown>): void {
    const playbookPath = join(this.workspaceDir, "memory", "sinain-playbook.md");
    if (!existsSync(playbookPath)) return;
    let content = readFileSync(playbookPath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    const newFooter = `<!-- effectiveness: outputs=${effectiveness.outputs ?? 0}, positive=${effectiveness.positive ?? 0}, negative=${effectiveness.negative ?? 0}, neutral=${effectiveness.neutral ?? 0}, rate=${effectiveness.rate ?? 0}, updated=${today} -->`;
    const footerRe = /<!--\s*effectiveness:[^>]+-->/;
    if (footerRe.test(content)) {
      content = content.replace(footerRe, newFooter);
    } else {
      content = content.trimEnd() + "\n\n" + newFooter + "\n";
    }
    writeFileSync(playbookPath, content, "utf-8");
  }

  // ── Modules ─────────────────────────────────────────────────────────────

  readModuleRegistry(): ModuleRegistry | null {
    const p = join(this.workspaceDir, "modules", "module-registry.json");
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as ModuleRegistry;
    } catch {
      return null;
    }
  }

  /**
   * Collect behavioral guidance from all active modules for prependContext injection.
   * Returns a formatted [MODULE GUIDANCE] block or empty string.
   */
  getActiveModuleGuidance(): string {
    const registryPath = join(this.workspaceDir, "modules", "module-registry.json");
    if (!existsSync(registryPath)) return "";

    let registry: ModuleRegistry;
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf-8")) as ModuleRegistry;
    } catch {
      return "";
    }

    // Active modules sorted by priority desc
    const activeModules: Array<{ id: string; priority: number }> = [];
    for (const [id, entry] of Object.entries(registry.modules)) {
      if (entry.status === "active") {
        activeModules.push({ id, priority: entry.priority });
      }
    }
    activeModules.sort((a, b) => b.priority - a.priority);

    const guidanceSections: string[] = [];
    let moduleCount = 0;

    for (const mod of activeModules) {
      const guidancePath = join(this.workspaceDir, "modules", mod.id, "guidance.md");
      if (!existsSync(guidancePath)) continue;

      try {
        const content = readFileSync(guidancePath, "utf-8").trim();
        if (!content) continue;

        let label = mod.id;
        const manifestPath = join(this.workspaceDir, "modules", mod.id, "manifest.json");
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
            if (manifest.importedAt) {
              label = `${manifest.name || mod.id} [transferred]`;
            }
          } catch {}
        }

        guidanceSections.push(`### ${label}\n${content}`);
        moduleCount++;
      } catch {
        // Skip unreadable guidance
      }
    }

    if (guidanceSections.length === 0) return "";

    this.logger.info(`sinain-hud: injecting guidance from ${moduleCount} module(s)`);
    return `[MODULE GUIDANCE]\n${guidanceSections.join("\n\n")}`;
  }

  // ── Session summaries ───────────────────────────────────────────────────

  appendSessionSummary(summary: Record<string, unknown>): void {
    const summaryPath = join(this.workspaceDir, "memory", "session-summaries.jsonl");
    const dir = dirname(summaryPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(summaryPath, JSON.stringify(summary) + "\n", { flag: "a" });
  }

  // ── Playbook logs ──────────────────────────────────────────────────────

  appendPlaybookLog(entry: Record<string, unknown>): void {
    const dateStr = new Date().toISOString().slice(0, 10);
    const logDir = join(this.workspaceDir, "memory", "playbook-logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, `${dateStr}.jsonl`),
      JSON.stringify(entry) + "\n",
      { flag: "a" },
    );
  }

  appendCurationLog(entry: Record<string, unknown>): void {
    this.appendPlaybookLog(entry);
  }

  // ── Eval ────────────────────────────────────────────────────────────────

  readEvalConfig(): Record<string, unknown> | null {
    const p = join(this.workspaceDir, "memory", "eval-config.json");
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  readLatestEvalReport(): string | null {
    const reportsDir = join(this.workspaceDir, "memory", "eval-reports");
    if (!existsSync(reportsDir)) return null;
    const reports = readdirSync(reportsDir)
      .filter((f: string) => f.endsWith(".md"))
      .sort()
      .reverse();
    if (reports.length === 0) return null;
    try {
      return readFileSync(join(reportsDir, reports[0]), "utf-8");
    } catch {
      return null;
    }
  }

  readRecentEvalLogs(n: number): string[] {
    const logsDir = join(this.workspaceDir, "memory", "eval-logs");
    if (!existsSync(logsDir)) return [];
    const logFiles = readdirSync(logsDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    if (logFiles.length === 0) return [];
    try {
      const content = readFileSync(join(logsDir, logFiles[0]), "utf-8");
      return content.trim().split("\n").slice(-n);
    } catch {
      return [];
    }
  }

  // ── SITUATION.md ────────────────────────────────────────────────────────

  readSituation(): string | null {
    const p = join(this.workspaceDir, "SITUATION.md");
    try {
      const content = readFileSync(p, "utf-8").trim();
      return content || null;
    } catch {
      return null;
    }
  }

  writeSituation(content: string): void {
    const situationPath = join(this.workspaceDir, "SITUATION.md");
    const tmpPath = situationPath + ".rpc.tmp";
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, situationPath);
  }
}
