import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, warn } from "../log.js";

const execFileAsync = promisify(execFile);

const TAG = "knowledge";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface KnowledgeContext {
  playbook: string;
  entities: string;
}

const EMPTY: KnowledgeContext = { playbook: "", entities: "" };

export class KnowledgeService {
  private koogRoot: string;
  private playbookCache: { content: string; ts: number } | null = null;

  constructor() {
    // Resolve project root from import.meta.url (works from src/ and dist/)
    const here = dirname(fileURLToPath(import.meta.url));
    // src/escalation/ → up 2 levels to sinain-core/, then up one more to project root
    const projectRoot = resolve(here, "../../..");
    this.koogRoot = process.env.KOOG_ROOT ?? join(projectRoot, "sinain-koog");
  }

  async getPlaybookPatterns(): Promise<string> {
    const now = Date.now();
    if (this.playbookCache && now - this.playbookCache.ts < CACHE_TTL_MS) {
      return this.playbookCache.content;
    }

    const playbookPath = join(this.koogRoot, "memory", "sinain-playbook.md");
    try {
      const raw = await readFile(playbookPath, "utf8");
      const content = extractPlaybookSections(raw);
      this.playbookCache = { content, ts: now };
      log(TAG, `loaded playbook: ${content.length} chars`);
      return content;
    } catch (err: any) {
      warn(TAG, `playbook read failed: ${err.message}`);
      return "";
    }
  }

  async getRelatedEntities(seedText: string, timeoutMs = 1500): Promise<string> {
    const dbPath = join(this.koogRoot, "triplestore.db");
    if (!existsSync(dbPath)) {
      return "";
    }

    const scriptPath = join(this.koogRoot, "triple_query.py");
    const memoryDir = join(this.koogRoot, "memory");

    try {
      const result = await Promise.race([
        execFileAsync("python3", [
          scriptPath,
          "--memory-dir", memoryDir,
          "--context", seedText.slice(0, 500),
          "--max-chars", "800",
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
      return (result as { stdout: string }).stdout.trim();
    } catch (err: any) {
      if (err.message !== "timeout") {
        warn(TAG, `triple_query failed: ${err.message}`);
      }
      return "";
    }
  }

  async getContext(digest: string): Promise<KnowledgeContext> {
    try {
      const [playbook, entities] = await Promise.all([
        this.getPlaybookPatterns(),
        this.getRelatedEntities(digest),
      ]);
      return { playbook, entities };
    } catch {
      return EMPTY;
    }
  }
}

/**
 * Extract "Established Patterns" and "Observed" sections from playbook markdown.
 * Skips the "Stale" section entirely.
 */
function extractPlaybookSections(raw: string): string {
  const lines = raw.split("\n");
  const result: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const sectionName = line.slice(3).trim();
      capturing = sectionName !== "Stale";
      if (capturing) result.push(line);
      continue;
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.join("\n").trim();
}
