/**
 * Wiki route dispatcher — serves the sinain:// address space as markdown
 * at GET /knowledge/<path> (docs/DESIGN-SINAIN-WIKI.md §2).
 *
 * Mounted inside createAppServer's request handler BEFORE the legacy
 * /knowledge JSON routes; the ".md" file-shaped paths cannot collide with
 * them, so both generations coexist during migration.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebDb } from "../web-db/store.js";
import {
  buildCatalog,
  buildEntityMd,
  buildEpisodeMd,
  buildIndexMd,
  buildLogMd,
  buildShareMd,
  buildSharesMd,
  buildTopicMd,
  buildWikiMd,
  entityToSlug,
  humanizeSlug,
  linkify,
  catalogNames,
  frontmatter,
  factToAnchor,
  slugToEntity,
  type CatalogEntry,
} from "./pages.js";
import { fetchEpisode, fetchEpisodes } from "./memoryd.js";
import { buildZip, type ZipEntry } from "./zip.js";

export interface WikiDeps {
  listKnowledgeEntities?: (max: number) => Promise<string>;
  renderEntityPage?: (entity: string, opts: { refresh: boolean; maxFacts: number }) => Promise<unknown>;
  graphChildren?: (entity: string) => Promise<unknown>;
  queryKnowledgeFacts?: (entities: string[], maxFacts: number) => Promise<string>;
  searchEntities?: (q: string, limit: number) => Promise<unknown>;
  exportKnowledge?: (domain: string | null, max: number) => Promise<string>;
  webDb?: WebDb;
}

// The raw --top dump backs the catalog, WIKI.md stats and linkify maps; it
// is refetched at most every 30s so rail/index fetches stay cheap.
let catalogCache: { at: number; raw: any[] } | null = null;
const CATALOG_TTL_MS = 30_000;
const CATALOG_MAX = 500;

async function rawCatalogItems(deps: WikiDeps): Promise<any[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.raw;
  let raw: any[] = [];
  if (deps.listKnowledgeEntities) {
    try {
      raw = JSON.parse(await deps.listKnowledgeEntities(CATALOG_MAX));
      if (!Array.isArray(raw)) raw = [];
    } catch { raw = []; }
  }
  catalogCache = { at: Date.now(), raw };
  return raw;
}

/** Test hook / cache-bust after imports. */
export function invalidateCatalogCache(): void {
  catalogCache = null;
}

function sendMd(res: ServerResponse, md: string): void {
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.end(md);
}

function notFoundMd(res: ServerResponse, path: string): void {
  res.statusCode = 404;
  sendMd(res, `# Not found\n\nNo page at \`sinain://${path}\`.\n`);
}

/**
 * Try to serve a wiki page. Returns true when the request was handled.
 * Only GETs under /knowledge/ with file-shaped paths reach the branches.
 */
export async function handleWikiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WikiDeps,
): Promise<boolean> {
  if (req.method !== "GET") return false;
  const p = url.pathname;
  if (!p.startsWith("/knowledge/")) return false;
  const path = p.slice("/knowledge/".length);

  // ── vault export (materialize every page once) ──
  if (path === "export" && url.searchParams.get("format") === "vault") {
    await handleVaultExport(res, deps);
    return true;
  }

  if (!path.endsWith(".md")) return false;

  // ── WIKI.md ≡ AGENTS.md ──
  if (path === "WIKI.md" || path === "AGENTS.md") {
    const raw = await rawCatalogItems(deps);
    const catalog = buildCatalog(raw);
    const factCount = raw.filter((r) => String(r.entity_id || r.entityId || "").startsWith("fact:")).length;
    const episodes = await fetchEpisodes({ limit: 200 });
    const lastIngest = episodes.length
      ? episodes.map((e) => String(e.t_end || e.t_start || "")).sort().pop() || null
      : null;
    sendMd(res, buildWikiMd({
      entities: catalog.length,
      facts: factCount,
      episodes: episodes.length || null,
      lastIngest,
    }));
    return true;
  }

  // ── index.md ──
  if (path === "index.md") {
    const catalog = buildCatalog(await rawCatalogItems(deps));
    const bookmarks = deps.webDb ? deps.webDb.listBookmarks("favorite", 12) : [];
    sendMd(res, buildIndexMd(catalog, bookmarks));
    return true;
  }

  // ── log.md ──
  if (path === "log.md") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const since = url.searchParams.get("since") || "";
    const episodes = await fetchEpisodes({ since, limit });
    sendMd(res, buildLogMd(episodes, { since, limit }));
    return true;
  }

  // ── shares.md ──
  if (path === "shares.md") {
    const shares = deps.webDb ? deps.webDb.listSharedDocs({ limit: 100 }) : [];
    sendMd(res, buildSharesMd(shares));
    return true;
  }

  // ── entity/<slug>.md ──
  if (path.startsWith("entity/")) {
    const slug = decodeURIComponent(path.slice("entity/".length, -".md".length));
    if (!slug) { notFoundMd(res, path); return true; }
    const entityId = slugToEntity(slug);
    if (!deps.renderEntityPage) { notFoundMd(res, path); return true; }
    const refresh = url.searchParams.get("refresh") === "1";
    const maxFacts = Math.min(parseInt(url.searchParams.get("max_facts") || "1000"), 5000);
    const [page, children, raw] = await Promise.all([
      deps.renderEntityPage(entityId, { refresh, maxFacts }) as Promise<any>,
      deps.graphChildren ? (deps.graphChildren(entityId) as Promise<any>).catch(() => null) : Promise.resolve(null),
      rawCatalogItems(deps),
    ]);
    // Recent-bookmark tracking only for UI-driven fetches — an LLM or curl
    // reading pages must not pollute the human's "recent" row.
    if (url.searchParams.get("ui") === "1" && deps.webDb) deps.webDb.touchVisit(entityId);
    sendMd(res, buildEntityMd(page, children, buildCatalog(raw)));
    return true;
  }

  // ── episode/<id>.md ──
  if (path.startsWith("episode/")) {
    const id = decodeURIComponent(path.slice("episode/".length, -".md".length));
    const ep = id ? await fetchEpisode(id) : null;
    if (!ep) { notFoundMd(res, path); return true; }
    const catalog = buildCatalog(await rawCatalogItems(deps));
    sendMd(res, buildEpisodeMd(ep, catalog));
    return true;
  }

  // ── topic/<q>.md ──
  if (path.startsWith("topic/")) {
    const q = decodeURIComponent(path.slice("topic/".length, -".md".length)).trim();
    if (!q) { notFoundMd(res, path); return true; }
    const entities = q.split(/[\s,+]+/).filter(Boolean);
    const [factsText, search, raw] = await Promise.all([
      deps.queryKnowledgeFacts ? deps.queryKnowledgeFacts(entities, 30).catch(() => "") : Promise.resolve(""),
      deps.searchEntities ? (deps.searchEntities(q, 10) as Promise<any>).catch(() => ({})) : Promise.resolve({}),
      rawCatalogItems(deps),
    ]);
    sendMd(res, buildTopicMd(q, factsText, search || {}, buildCatalog(raw)));
    return true;
  }

  // ── share/<token>.md ──
  if (path.startsWith("share/")) {
    const token = decodeURIComponent(path.slice("share/".length, -".md".length));
    const share = token && deps.webDb ? deps.webDb.getSharedDoc(token) : null;
    if (!share) { notFoundMd(res, path); return true; }
    sendMd(res, buildShareMd(share));
    return true;
  }

  return false;
}

// ── vault export ──────────────────────────────────────────────────────
//
// Materializes the address space once into an Obsidian-openable zip.
// Entity pages are built deterministically from the fact dump (one
// subprocess call) rather than through the LLM page renderer — exporting
// hundreds of pages must never queue hundreds of LLM calls. Cached LLM
// summaries are a possible later refinement.

async function handleVaultExport(res: ServerResponse, deps: WikiDeps): Promise<void> {
  const entries: ZipEntry[] = [];

  // Fact dump: exportKnowledge returns { facts: [...] } including fact:*
  // rows (with subject pointer in their `entity` attr) and entity:* rows.
  let factRows: any[] = [];
  if (deps.exportKnowledge) {
    try {
      const parsed = JSON.parse(await deps.exportKnowledge(null, 500));
      factRows = Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch { factRows = []; }
  }

  const catalog = buildCatalog(factRows);
  const names = catalogNames(catalog);
  const entryBySlug = new Map(catalog.map((c) => [c.slug, c] as const));

  // Group fact rows under their subject entity slug.
  const factsBySlug = new Map<string, any[]>();
  for (const f of factRows) {
    const id = String(f.entity_id || f.entityId || "");
    if (!id.startsWith("fact:")) continue;
    const subject = typeof f.entity === "string" ? f.entity : "";
    if (!subject) continue;
    const slug = entityToSlug(subject.includes(":") ? subject : `entity:${subject}`);
    if (!factsBySlug.has(slug)) factsBySlug.set(slug, []);
    factsBySlug.get(slug)!.push(f);
  }

  // Entity pages — every catalog node plus any fact subject not in the catalog.
  const slugs = new Set<string>([...catalog.map((c) => c.slug), ...factsBySlug.keys()]);
  for (const slug of slugs) {
    const entry: CatalogEntry | undefined = entryBySlug.get(slug);
    const entityId = slugToEntity(slug);
    const title = entry?.name || humanizeSlug(entityId);
    const facts = factsBySlug.get(slug) || [];
    const parts: string[] = [
      frontmatter({
        id: entityId,
        type: entry?.type,
        title,
        domain: entry?.domain,
        confidence: entry?.confidence !== undefined ? entry.confidence.toFixed(2) : undefined,
      }),
      "",
      `# ${title}`,
      "",
    ];
    if (facts.length) {
      parts.push("## Facts", "");
      for (const f of facts) {
        const value = String(Array.isArray(f.value) ? f.value[0] : f.value || "").replace(/\n/g, " ");
        if (!value) continue;
        const conf = Number(Array.isArray(f.confidence) ? f.confidence[0] : f.confidence);
        const confStr = Number.isFinite(conf) ? ` · conf ${conf.toFixed(2)}` : "";
        const fid = String(f.entity_id || f.entityId);
        parts.push(`- ${linkify(value, names)}${confStr} ^${factToAnchor(fid)}`);
      }
      parts.push("");
    }
    entries.push({ path: `entity/${slug}.md`, content: parts.join("\n") });
  }

  // Root pages.
  const episodes = await fetchEpisodes({ limit: 200 });
  const lastIngest = episodes.length
    ? episodes.map((e) => String(e.t_end || e.t_start || "")).sort().pop() || null
    : null;
  const wikiMd = buildWikiMd({
    entities: catalog.length,
    facts: factRows.filter((r) => String(r.entity_id || r.entityId || "").startsWith("fact:")).length,
    episodes: episodes.length || null,
    lastIngest,
  });
  const bookmarks = deps.webDb ? deps.webDb.listBookmarks("favorite", 12) : [];
  entries.push({ path: "WIKI.md", content: wikiMd });
  entries.push({ path: "AGENTS.md", content: wikiMd });
  entries.push({ path: "index.md", content: buildIndexMd(catalog, bookmarks) });
  entries.push({ path: "log.md", content: buildLogMd(episodes, { limit: 200 }) });
  entries.push({
    path: "README.md",
    content:
      "# Sinain vault export\n\nMaterialized snapshot of the live sinain wiki (sinain://). "
      + "Open this folder as an Obsidian vault. Entity pages here are the deterministic "
      + "fact projection — LLM summaries render live at /knowledge/entity/<slug>.md.\n",
  });

  const zip = buildZip(entries);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="sinain-vault.zip"`);
  res.end(zip);
}
