/**
 * sinain-knowledge — Snapshot export/import
 *
 * Serializes the entire knowledge state (playbook, modules, triplestore, logs, config)
 * to a portable JSON format for backup and cross-instance transfer.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import type { ModuleRegistry } from "./schema.js";
import type { KnowledgeStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface KnowledgeSnapshot {
  version: 2;
  integrity: string;
  exportedAt: string;
  exportedFrom: string;
  playbook: {
    base: string;
    effective: string;
    archive: Array<{ ts: string; content: string }>;
  };
  modules: {
    registry: ModuleRegistry | null;
    items: Array<{
      id: string;
      manifest: Record<string, unknown> | null;
      patterns: string;
      guidance: string;
    }>;
  };
  triplestore: {
    dbBase64: string;
  };
  logs: {
    sessionSummaries: string;
    recentPlaybookLogs: string[];
    recentEvalLogs: string[];
  };
  config: {
    memoryConfig: Record<string, unknown> | null;
    evalConfig: Record<string, unknown> | null;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function computeIntegrity(snapshot: Omit<KnowledgeSnapshot, "integrity">): string {
  const content = JSON.stringify({ ...snapshot, integrity: "" });
  return createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Export
// ============================================================================

export function exportSnapshot(store: KnowledgeStore): KnowledgeSnapshot {
  const workspaceDir = store.getWorkspaceDir();

  // Playbook
  const base = store.readPlaybook() ?? "";
  const effective = store.readEffectivePlaybook() ?? "";
  const archiveDir = join(workspaceDir, "memory", "playbook-archive");
  const archive: Array<{ ts: string; content: string }> = [];
  if (existsSync(archiveDir)) {
    const files = readdirSync(archiveDir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 10);
    for (const f of files) {
      archive.push({ ts: f.replace(".md", ""), content: readFileSafe(join(archiveDir, f)) });
    }
  }

  // Modules
  const registry = store.readModuleRegistry();
  const items: KnowledgeSnapshot["modules"]["items"] = [];
  if (registry) {
    for (const id of Object.keys(registry.modules)) {
      const modDir = join(workspaceDir, "modules", id);
      items.push({
        id,
        manifest: readJsonSafe(join(modDir, "manifest.json")),
        patterns: readFileSafe(join(modDir, "patterns.md")),
        guidance: readFileSafe(join(modDir, "guidance.md")),
      });
    }
  }

  // Triplestore
  const dbPath = join(workspaceDir, "memory", "triples.db");
  let dbBase64 = "";
  if (existsSync(dbPath)) {
    try {
      dbBase64 = readFileSync(dbPath).toString("base64");
    } catch {}
  }

  // Logs
  const sessionSummaries = readFileSafe(join(workspaceDir, "memory", "session-summaries.jsonl"));
  const recentPlaybookLogs: string[] = [];
  const pbLogDir = join(workspaceDir, "memory", "playbook-logs");
  if (existsSync(pbLogDir)) {
    const files = readdirSync(pbLogDir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 7);
    for (const f of files) {
      recentPlaybookLogs.push(readFileSafe(join(pbLogDir, f)));
    }
  }
  const recentEvalLogs = store.readRecentEvalLogs(20);

  // Config
  const evalConfig = store.readEvalConfig();
  const memoryConfig = readJsonSafe(join(workspaceDir, "memory", "memory-config.json"));

  const partial = {
    version: 2 as const,
    exportedAt: new Date().toISOString(),
    exportedFrom: workspaceDir,
    playbook: { base, effective, archive },
    modules: { registry, items },
    triplestore: { dbBase64 },
    logs: { sessionSummaries, recentPlaybookLogs, recentEvalLogs },
    config: { memoryConfig, evalConfig },
  };

  return {
    ...partial,
    integrity: computeIntegrity(partial),
  };
}

// ============================================================================
// Import
// ============================================================================

export function importSnapshot(store: KnowledgeStore, snapshot: KnowledgeSnapshot): void {
  const workspaceDir = store.getWorkspaceDir();

  // Verify integrity
  const expected = computeIntegrity({ ...snapshot, integrity: "" });
  if (expected !== snapshot.integrity) {
    throw new Error(`Snapshot integrity mismatch: expected ${expected}, got ${snapshot.integrity}`);
  }

  store.ensureMemoryDirs();

  // Playbook
  if (snapshot.playbook.base) {
    store.writePlaybook(snapshot.playbook.base);
  }
  if (snapshot.playbook.effective) {
    const effectivePath = join(workspaceDir, "memory", "sinain-playbook-effective.md");
    writeFileSync(effectivePath, snapshot.playbook.effective, "utf-8");
  }
  for (const entry of snapshot.playbook.archive) {
    const archiveDir = join(workspaceDir, "memory", "playbook-archive");
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `${entry.ts}.md`), entry.content, "utf-8");
  }

  // Modules
  if (snapshot.modules.registry) {
    const modulesDir = join(workspaceDir, "modules");
    if (!existsSync(modulesDir)) mkdirSync(modulesDir, { recursive: true });
    writeFileSync(join(modulesDir, "module-registry.json"), JSON.stringify(snapshot.modules.registry, null, 2), "utf-8");
  }
  for (const mod of snapshot.modules.items) {
    const modDir = join(workspaceDir, "modules", mod.id);
    if (!existsSync(modDir)) mkdirSync(modDir, { recursive: true });
    if (mod.manifest) writeFileSync(join(modDir, "manifest.json"), JSON.stringify(mod.manifest, null, 2), "utf-8");
    if (mod.patterns) writeFileSync(join(modDir, "patterns.md"), mod.patterns, "utf-8");
    if (mod.guidance) writeFileSync(join(modDir, "guidance.md"), mod.guidance, "utf-8");
  }

  // Triplestore
  if (snapshot.triplestore.dbBase64) {
    const dbPath = join(workspaceDir, "memory", "triples.db");
    writeFileSync(dbPath, Buffer.from(snapshot.triplestore.dbBase64, "base64"));
  }

  // Logs
  if (snapshot.logs.sessionSummaries) {
    writeFileSync(join(workspaceDir, "memory", "session-summaries.jsonl"), snapshot.logs.sessionSummaries, "utf-8");
  }

  // Config
  if (snapshot.config.evalConfig) {
    writeFileSync(join(workspaceDir, "memory", "eval-config.json"), JSON.stringify(snapshot.config.evalConfig, null, 2), "utf-8");
  }
  if (snapshot.config.memoryConfig) {
    writeFileSync(join(workspaceDir, "memory", "memory-config.json"), JSON.stringify(snapshot.config.memoryConfig, null, 2), "utf-8");
  }
}
