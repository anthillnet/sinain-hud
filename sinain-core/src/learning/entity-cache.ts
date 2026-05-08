/**
 * Entity subscription cache — detects entity mentions in real-time transcription
 * and prefetches knowledge facts for injection into the agent prompt.
 *
 * Flow: transcript → detectEntities() → prefetch() → getRelevantFacts()
 * The 3s agent debounce ensures prefetch completes before the next analysis tick.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log, warn } from "../log.js";

const TAG = "entity-cache";
const MAX_ENTRIES = 50;
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const JUNK_RE = /^[a-f0-9]{6,}$|^\d+$|^-+$/; // commit hashes, pure numbers, dashes

interface CacheEntry {
  facts: string;
  ts: number;
}

type QueryFn = (entities: string[], maxFacts: number) => Promise<string>;

export class EntityCache {
  private cache = new Map<string, CacheEntry>();
  private knownEntities: string[] = [];
  private pendingQueries = new Set<string>();
  private queryFn: QueryFn;
  private evictionOrder: string[] = [];

  constructor(queryFn: QueryFn) {
    this.queryFn = queryFn;
  }

  /** Load entity names from the knowledge graph (async, non-blocking). */
  async loadEntityNames(): Promise<void> {
    try {
      const __dir = dirname(fileURLToPath(import.meta.url));
      const localDir = process.env.SINAIN_MEMORY_DIR
        || process.env.OPENCLAW_WORKSPACE_DIR
          ? `${(process.env.OPENCLAW_WORKSPACE_DIR || "").replace(/~/, process.env.HOME || "")}/memory`
          : `${process.env.HOME}/.sinain/memory`;
      const workspaceDir = `${(process.env.OPENCLAW_WORKSPACE_DIR || "").replace(/~/, process.env.HOME || "")}/memory`;

      const dbPaths = [
        `${localDir}/knowledge-graph.db`,
        `${workspaceDir}/knowledge-graph.db`,
      ].filter(p => existsSync(p));

      if (dbPaths.length === 0) {
        log(TAG, "no knowledge-graph.db found — entity detection disabled");
        return;
      }

      // Query entity names directly via SQLite.
      // Two package layouts are supported:
      //   dev/monorepo: <repo>/sinain-core/src/learning/ → ../../../sinain-hud-plugin/sinain-memory
      //   npm-published flat: <pkg>/sinain-core/src/learning/ → ../../../sinain-memory
      const scriptCandidates = [
        resolve(__dir, "..", "..", "..", "sinain-hud-plugin", "sinain-memory", "graph_query.py"),  // dev/monorepo layout
        resolve(__dir, "..", "..", "..", "sinain-memory", "graph_query.py"),                        // npm-published flat layout
        resolve(__dir, "..", "..", "sinain-memory", "graph_query.py"),                             // legacy alt
      ];
      const scriptPath = scriptCandidates.find(p => existsSync(p));
      if (!scriptPath) return;

      const names = new Set<string>();
      for (const dbPath of dbPaths) {
        try {
          const out = execFileSync("python3", [
            "-c",
            `import sys; sys.path.insert(0, "${dirname(scriptPath)}"); ` +
            `from triplestore import TripleStore; store = TripleStore("${dbPath}"); ` +
            `[print(n) for _, n in store.entities_with_attr("name") if _.startswith("entity:")]`,
          ], { timeout: 5000, encoding: "utf-8" });
          for (const line of out.split("\n")) {
            const name = line.trim();
            if (name.length >= 4 && !JUNK_RE.test(name)) {
              names.add(name);
            }
          }
        } catch { /* skip */ }
      }

      this.knownEntities = [...names].sort((a, b) => b.length - a.length); // longest first for greedy match
      log(TAG, `loaded ${this.knownEntities.length} entity names`);
    } catch (e: any) {
      warn(TAG, `loadEntityNames failed: ${e.message?.slice(0, 80)}`);
    }
  }

  /**
   * Detect entity mentions in text. Synchronous, <1ms.
   * Checks known entity names via substring match + extracts capitalized phrases.
   */
  detectEntities(text: string): string[] {
    const lower = text.toLowerCase();
    const found = new Set<string>();

    // Known entity substring match (longest first avoids partial matches)
    for (const name of this.knownEntities) {
      if (found.size >= 5) break;
      if (name.length < 5) {
        // Short names: require word boundary
        const re = new RegExp(`\\b${name.replace(/-/g, "[- ]?")}\\b`, "i");
        if (re.test(lower)) found.add(name);
      } else {
        // Longer names: simple indexOf (spaces → optional hyphens)
        const searchable = name.replace(/-/g, " ");
        if (lower.includes(searchable) || lower.includes(name)) {
          found.add(name);
        }
      }
    }

    // Capitalized multi-word phrases (catch entities not yet in graph)
    const caps = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
    if (caps) {
      for (const phrase of caps.slice(0, 3)) {
        const normalized = phrase.toLowerCase().replace(/\s+/g, "-");
        if (normalized.length >= 4 && !found.has(normalized)) {
          found.add(normalized);
          if (found.size >= 5) break;
        }
      }
    }

    return [...found];
  }

  /** Async prefetch: fire-and-forget knowledge queries for cache misses. */
  prefetch(entities: string[]): void {
    const toFetch = entities.filter(e => !this.cache.has(e) && !this.pendingQueries.has(e));
    if (toFetch.length === 0) return;

    for (const entity of toFetch) {
      this.pendingQueries.add(entity);
      this.queryFn([entity], 3)
        .then(facts => {
          this.cache.set(entity, { facts, ts: Date.now() });
          this.evictionOrder.push(entity);
          this.evict();
        })
        .catch(() => { /* silent */ })
        .finally(() => this.pendingQueries.delete(entity));
    }
  }

  /** Get cached facts for entities. Synchronous — only reads pre-fetched data. */
  getRelevantFacts(entities: string[], maxChars: number): string {
    const parts: string[] = [];
    let total = 0;

    for (const entity of entities) {
      const entry = this.cache.get(entity);
      if (!entry || Date.now() - entry.ts > TTL_MS || !entry.facts) continue;
      if (total + entry.facts.length + 2 > maxChars) break;
      parts.push(entry.facts);
      total += entry.facts.length + 2;
    }

    return parts.join("; ");
  }

  /** Number of cached entities. */
  get size(): number {
    return this.cache.size;
  }

  /** Number of known entity names loaded from the graph. */
  get entityCount(): number {
    return this.knownEntities.length;
  }

  private evict(): void {
    while (this.cache.size > MAX_ENTRIES && this.evictionOrder.length > 0) {
      const oldest = this.evictionOrder.shift()!;
      this.cache.delete(oldest);
    }
  }
}
