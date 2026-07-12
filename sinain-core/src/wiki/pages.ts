/**
 * Virtual wiki pages — markdown builders for the sinain:// address space.
 *
 * The wiki is a protocol, not a folder (docs/DESIGN-SINAIN-WIKI.md): every
 * page here is rendered on demand from the stores and served as
 * text/markdown at GET /knowledge/<path>. The same bytes go to the web UI,
 * an LLM over MCP, and `curl` — one renderer, no drift.
 *
 * Page format contract (§3 of the design doc):
 *  - YAML-ish frontmatter maps 1:1 to store attributes; fields are omitted
 *    when unknown rather than emitted empty.
 *  - Fact bullets end with `· conf 0.92 ^f-<id>` — the block anchor is the
 *    round-trip handle for retraction (UI + MCP annotate) and is stable
 *    across machines (content-addressed fact slugs).
 *  - Cross-references are [[wikilinks]]. Bare targets are entity slugs;
 *    targets containing "/" address other page types (episode/…, share/…).
 */

// ── slug / anchor mapping ─────────────────────────────────────────────
// Entity ids look like "entity:igor", "concept:foo", "fact:bar". Path
// segments and anchors must be filename/anchor-safe, so ":" is encoded as
// "__" for non-default prefixes and the default prefix is stripped.

/** entity id → path slug: entity:igor → igor; concept:foo → concept__foo */
export function entityToSlug(entityId: string): string {
  if (entityId.startsWith("entity:")) return entityId.slice("entity:".length);
  return entityId.replace(":", "__");
}

/** path slug → entity id (inverse of entityToSlug) */
export function slugToEntity(slug: string): string {
  if (slug.includes("__")) return slug.replace("__", ":");
  if (slug.includes(":")) return slug; // already an id (tolerated on input)
  return `entity:${slug}`;
}

/** fact id → block anchor body: fact:x → f-x; signal:y → f-signal__y */
export function factToAnchor(factId: string): string {
  if (factId.startsWith("fact:")) return `f-${factId.slice("fact:".length)}`;
  return `f-${factId.replace(":", "__")}`;
}

/** block anchor body → fact id (inverse of factToAnchor) */
export function anchorToFact(anchor: string): string {
  const body = anchor.startsWith("f-") ? anchor.slice(2) : anchor;
  if (body.includes("__")) return body.replace("__", ":");
  if (body.includes(":")) return body;
  return `fact:${body}`;
}

/** Human title from an entity id: entity:memory-v2 → Memory V2 (unless a
 *  proper name is known). */
export function humanizeSlug(entityId: string): string {
  const slug = entityToSlug(entityId).replace("__", ": ");
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── shared bits ───────────────────────────────────────────────────────

/** The five typed domains (DESIGN-MEMORY-V2) lead the catalog; anything
 *  else the store contains follows alphabetically. */
export const CANONICAL_DOMAINS = [
  "endeavors",
  "people",
  "preferences",
  "decisions",
  "procedures",
];

function fmLine(key: string, value: string | number | string[] | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${key}: [${value.join(", ")}]`;
  }
  return `${key}: ${value}`;
}

export function frontmatter(fields: Record<string, string | number | string[] | undefined | null>): string {
  const lines = Object.entries(fields)
    .map(([k, v]) => fmLine(k, v))
    .filter((l): l is string => l !== null);
  return ["---", ...lines, "---"].join("\n");
}

/** Wrap known entity names in [[wikilinks]] (first occurrence per name).
 *  Deterministic auto-linking — gives pages their cross-references even
 *  where upstream text is plain prose. `names` maps display name → slug. */
export function linkify(text: string, names: Map<string, string>): string {
  let out = text;
  for (const [name, slug] of names) {
    if (name.length < 4) continue;
    if (out.includes(`[[${slug}]]`) || out.includes(`[[${slug}|`)) continue;
    // Word-boundary, case-sensitive first match; skip if inside an existing link.
    const idx = out.indexOf(name);
    if (idx < 0) continue;
    const before = out.slice(0, idx);
    if (before.lastIndexOf("[[") > before.lastIndexOf("]]")) continue;
    const alias = name === humanizeSlug(`entity:${slug}`) ? `[[${slug}]]` : `[[${slug}|${name}]]`;
    out = before + alias + out.slice(idx + name.length);
  }
  return out;
}

// ── catalog (shared input for index.md, rails, linkify) ──────────────

export interface CatalogEntry {
  id: string;        // entity:igor
  slug: string;      // igor
  name: string;      // Igor Gerasimov
  type?: string;
  domain?: string;
  confidence?: number;
  factCount?: number;
}

/**
 * Normalize the raw `--top --format json` dump into an entity catalog.
 *
 * The live Oxigraph store returns fact:* rows here (each carrying its
 * subject slug in the `entity` attr), so the catalog is aggregated from
 * fact subjects — "most-evidenced entities", ranked by fact count.
 * entity:* rows (typed domains from memory_v2 T2, once that seam closes)
 * are honored directly when present.
 */
export function buildCatalog(rawItems: any[]): CatalogEntry[] {
  const bySlug = new Map<string, CatalogEntry>();
  const first = (v: any) => (Array.isArray(v) ? v[0] : v);

  for (const item of rawItems) {
    const id: string = String(item.entity_id || item.entityId || "");
    if (id.startsWith("entity:")) {
      const slug = entityToSlug(id);
      const prev = bySlug.get(slug);
      const name = typeof item.name === "string" && item.name && item.name !== slug
        ? item.name
        : prev?.name || humanizeSlug(id);
      bySlug.set(slug, {
        id, slug, name,
        type: typeof first(item.type) === "string" ? first(item.type) : prev?.type,
        domain: typeof first(item.domain) === "string" ? first(item.domain) : prev?.domain,
        confidence: prev?.confidence,
        factCount: prev?.factCount ?? 0,
      });
      continue;
    }
    if (!id.startsWith("fact:")) continue;
    const subject = typeof item.entity === "string" ? item.entity : "";
    if (!subject) continue;
    // Session-timestamp subjects ("2026-06-30T13:48") are ingest artifacts,
    // not knowledge entities — their pages render empty. Keep them out of
    // the catalog; direct links still resolve.
    if (/^\d{4}-\d{2}-\d{2}/.test(subject)) continue;
    const entityId = subject.includes(":") ? subject : `entity:${subject}`;
    const slug = entityToSlug(entityId);
    let entry = bySlug.get(slug);
    if (!entry) {
      entry = { id: entityId, slug, name: humanizeSlug(entityId), factCount: 0 };
      bySlug.set(slug, entry);
    }
    entry.factCount = (entry.factCount ?? 0) + 1;
    const domain = first(item.domain);
    if (!entry.domain && typeof domain === "string") entry.domain = domain;
    const conf = Number(first(item.confidence));
    if (Number.isFinite(conf)) {
      // Running mean keeps the entry's confidence stable and order-free.
      const n = entry.factCount;
      entry.confidence = entry.confidence === undefined ? conf : entry.confidence + (conf - entry.confidence) / n;
    }
  }
  return [...bySlug.values()].sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0));
}

export function catalogNames(catalog: CatalogEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of catalog.slice(0, 500)) m.set(e.name, e.slug);
  return m;
}

function groupByDomain(catalog: CatalogEntry[]): Array<{ domain: string; entries: CatalogEntry[] }> {
  const byDomain = new Map<string, CatalogEntry[]>();
  for (const e of catalog) {
    // Today's store rarely carries domains; "entities" is the honest
    // catch-all until memory_v2's five typed domains populate.
    const d = (e.domain || "entities").toLowerCase();
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(e);
  }
  const order = [
    ...CANONICAL_DOMAINS.filter((d) => byDomain.has(d)),
    ...[...byDomain.keys()].filter((d) => !CANONICAL_DOMAINS.includes(d)).sort(),
  ];
  // Within a group, most-evidenced first — a 500-entity flat bucket sorted
  // alphabetically buries everything that matters.
  return order.map((domain) => ({
    domain,
    entries: byDomain.get(domain)!.sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0) || a.name.localeCompare(b.name)),
  }));
}

function titleCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── WIKI.md ───────────────────────────────────────────────────────────

export interface WikiStats {
  entities: number;
  facts: number;
  episodes: number | null;
  lastIngest: string | null;
}

export function buildWikiMd(stats: WikiStats): string {
  const fm = frontmatter({
    id: "WIKI",
    title: "Sinain Wiki",
    entities: stats.entities,
    facts: stats.facts,
    episodes: stats.episodes ?? undefined,
    last_ingest: stats.lastIngest ?? undefined,
  });
  return `${fm}

# Sinain Wiki

The knowledge API, shaped as a wiki. Every page is rendered on demand from
the live stores — nothing here is a file, so nothing here is stale. This
page is the schema layer: read it once and you can operate the whole vault.

## Address space

Resolve \`sinain://X\` by prepending your local mount (\`GET /knowledge/X\`
on this machine). Wikilinks are relative; neither prefix appears inside
page bodies.

## Conventions

- Fact bullets carry block anchors (\`^f-<id>\`) — the round-trip handle for
  edits, retraction and cross-machine identity at once.
- Refs are [[wikilinks]]; typed edges use inline fields
  (\`worksAt:: [[acme]]\`) — graph-visible, queryable, machine-parseable.
- Bare wikilink targets are entity slugs (\`[[igor]]\` → \`entity/igor.md\`);
  targets with a "/" address other page types (\`[[episode/ep-x]]\`).
- Entity ids map to paths by stripping the \`entity:\` prefix; other id
  prefixes encode ":" as "__" (\`concept:foo\` → \`entity/concept__foo.md\`).
- Current facts live in the body; superseded facts move to \`## History\`
  with validity windows. The page shows the story; the store keeps the truth.
- Frontmatter maps 1:1 to store attributes; unknown fields are omitted.

## Page types

- \`WIKI.md\` ≡ \`AGENTS.md\` — this file: conventions, page types, operations, live stats
- \`index.md\` — the catalog, grouped by domain; a query, never stale
- \`entity/<slug>.md\` — frontmatter + facts with ^anchors + [[wikilinks]] + related + history
- \`log.md?since=&limit=\` — append-only record, virtually paginated
- \`episode/<id>.md\` — one T1 episode: immutable escrow, provenance drill-down target
- \`topic/<q>.md\` — a query filed back as a page
- \`shares.md\`, \`share/<id>.md\` — scoped slices of this address space
- \`lint.md\` — health check: facts that fail the durability rules, grouped by verdict

## Operations (HTTP today, MCP \`sinain-wiki\` planned)

- search — \`GET /knowledge/search?q=&limit=\` → matching entities + snippets
- read — \`GET /knowledge/<any path above>\` → the page, as markdown
- annotate — \`DELETE /knowledge/facts/<fact-id>\` (retract, returns undo_token),
  \`POST /knowledge/facts/<fact-id>/restore\` — bi-temporal, nothing is deleted
- ingest — \`POST /knowledge/concepts/import\` (concept bundles);
  vault import (markdown folders) lands with P3
- lint — \`GET /knowledge/lint.md\` (findings: escrow / ephemeral / fragment /
  unattributed), \`POST /knowledge/lint/apply\` — bulk bi-temporal retraction
- export_vault — \`GET /knowledge/export?format=vault\` → every page
  materialized once into an Obsidian-openable zip

## Stats

- ${stats.entities} entities · ${stats.facts} facts${stats.episodes != null ? ` · ${stats.episodes} episodes` : ""}${stats.lastIngest ? `\n- last ingest: ${stats.lastIngest}` : ""}
`;
}

// ── index.md ──────────────────────────────────────────────────────────

export interface IndexBookmark {
  entity_id: string;
  status: string;
}

export function buildIndexMd(catalog: CatalogEntry[], bookmarks: IndexBookmark[], opts?: { dropped?: number }): string {
  const fm = frontmatter({ id: "index", title: "Index", entities: catalog.length });
  const parts: string[] = [fm, "", "# Index", ""];
  parts.push("The catalog is a query — always current by construction.", "");

  const favs = bookmarks.filter((b) => b.status === "favorite");
  if (favs.length) {
    parts.push("## Bookmarks", "");
    for (const b of favs.slice(0, 12)) {
      parts.push(`- [[${entityToSlug(b.entity_id)}]] — favorite`);
    }
    parts.push("");
  }

  for (const { domain, entries } of groupByDomain(catalog)) {
    parts.push(`## ${titleCase(domain)} (${entries.length})`, "");
    for (const e of entries) {
      const meta: string[] = [];
      if (e.type) meta.push(e.type);
      if (e.factCount) meta.push(`${e.factCount} fact${e.factCount === 1 ? "" : "s"}`);
      if (e.confidence !== undefined) meta.push(`conf ${e.confidence.toFixed(2)}`);
      parts.push(`- [[${e.slug}${e.name !== humanizeSlug(e.id) ? `|${e.name}` : ""}]]${meta.length ? ` — ${meta.join(" · ")}` : ""}`);
    }
    parts.push("");
  }
  if (opts?.dropped) {
    parts.push(`*Catalog capped — ${opts.dropped} more entities not listed. Narrow via search.*`, "");
  }
  return parts.join("\n");
}

// ── entity/<slug>.md ──────────────────────────────────────────────────

export interface EntityPageJson {
  entity: string;
  tx_watermark?: number;
  fact_count?: number;
  summary?: string;
  sections?: Array<{
    heading?: string;
    bullets?: Array<{ fact_id?: string; text?: string; confidence?: number; domain?: string }>;
  }>;
}

export interface GraphChildrenJson {
  entity?: string;
  groups?: Array<{
    label?: string;
    edge_attr?: string;
    children?: Array<{ entity?: string; fact_count?: number; domain?: string; snippet?: string }>;
  }>;
}

export function buildEntityMd(
  page: EntityPageJson,
  children: GraphChildrenJson | null,
  catalog: CatalogEntry[],
): string {
  const entityId = page.entity;
  const slug = entityToSlug(entityId);
  const entry = catalog.find((c) => c.id === entityId);
  const title = entry?.name || humanizeSlug(entityId);
  const names = catalogNames(catalog.filter((c) => c.id !== entityId));

  // Domain: explicit from catalog, else the mode of bullet domains.
  let domain = entry?.domain;
  if (!domain) {
    const counts = new Map<string, number>();
    for (const sec of page.sections || []) {
      for (const b of sec.bullets || []) {
        if (b.domain) counts.set(b.domain, (counts.get(b.domain) || 0) + 1);
      }
    }
    domain = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  const confidences = (page.sections || [])
    .flatMap((s) => s.bullets || [])
    .map((b) => b.confidence)
    .filter((c): c is number => typeof c === "number");
  const conf = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : undefined;

  const fm = frontmatter({
    id: entityId,
    type: entry?.type,
    title,
    domain,
    confidence: conf !== undefined ? conf.toFixed(2) : undefined,
    facts: page.fact_count,
    tx: page.tx_watermark,
  });

  const parts: string[] = [fm, "", `# ${title}`, ""];
  if (page.summary) {
    parts.push(linkify(page.summary, names), "");
  }

  for (const sec of page.sections || []) {
    const bullets = (sec.bullets || []).filter((b) => b.text);
    if (!bullets.length) continue;
    parts.push(`## ${sec.heading || "Facts"}`, "");
    for (const b of bullets) {
      const text = linkify(b.text!, names);
      const conf = typeof b.confidence === "number" ? ` · conf ${b.confidence.toFixed(2)}` : "";
      const anchor = b.fact_id ? ` ^${factToAnchor(b.fact_id)}` : "";
      parts.push(`- ${text}${conf}${anchor}`);
    }
    parts.push("");
  }

  // Related = backrefs, entity nodes only (fact backrefs are already the
  // fact bullets above on their own pages).
  const related: string[] = [];
  const seenRel = new Set<string>();
  for (const g of children?.groups || []) {
    for (const c of g.children || []) {
      const cid = c.entity || "";
      if (!cid.startsWith("entity:") || cid === entityId || seenRel.has(cid)) continue;
      seenRel.add(cid);
      const label = (g.edge_attr || g.label || "related").toString();
      related.push(`- [[${entityToSlug(cid)}]] — ${label} (backref)`);
      if (related.length >= 20) break;
    }
    if (related.length >= 20) break;
  }
  if (related.length) {
    parts.push("## Related", "", ...related, "");
  }

  return parts.join("\n");
}

// ── log.md / episode/<id>.md ─────────────────────────────────────────

export interface EpisodeJson {
  id: string;
  context_id?: string;
  t_start?: string | number;
  t_end?: string | number;
  kind?: string;
  source?: string;
  summary?: string;
  text?: string;
  entities?: string[];
}

function epTs(e: EpisodeJson): string {
  const t = e.t_start ?? "";
  if (typeof t === "number") return new Date(t * (t > 1e12 ? 1 : 1000)).toISOString().slice(0, 16).replace("T", " ");
  return String(t).slice(0, 16).replace("T", " ");
}

export function buildLogMd(episodes: EpisodeJson[], opts: { since?: string; limit: number }): string {
  const fm = frontmatter({ id: "log", title: "Log", entries: episodes.length });
  const parts: string[] = [fm, "", "# Log", ""];
  parts.push(
    "The append-only record, virtually paginated — every entry links to its episode page.",
    "",
  );
  for (const e of episodes) {
    const kind = e.kind || "event";
    const summary = (e.summary || "").replace(/\n/g, " ").slice(0, 120);
    parts.push(`- [${epTs(e)}] **${kind}** [[episode/${e.id}]]${e.context_id ? ` ${e.context_id}` : ""}${summary ? ` — ${summary}` : ""}`);
  }
  if (!episodes.length) parts.push("*No episodes yet — memoryd has recorded nothing in this window.*");
  parts.push("", `*?since=${opts.since || ""}&limit=${opts.limit}*`, "");
  return parts.join("\n");
}

export function buildEpisodeMd(e: EpisodeJson, catalog: CatalogEntry[]): string {
  const fm = frontmatter({
    id: e.id,
    kind: e.kind,
    t_start: e.t_start !== undefined ? String(e.t_start) : undefined,
    t_end: e.t_end !== undefined ? String(e.t_end) : undefined,
    source: e.source,
    context: e.context_id,
  });
  const parts: string[] = [fm, "", `# ${e.id}`, ""];
  parts.push("T1 escrow — immutable. Whatever extraction missed, this text stays retrievable.", "");
  if (e.summary) parts.push(`> ${e.summary.replace(/\n/g, "\n> ")}`, "");
  if (e.text) {
    parts.push("## Text", "", e.text.trim(), "");
  }
  const known = new Map(catalog.map((c) => [c.name.toLowerCase(), c.slug]));
  const ents = (e.entities || []).slice(0, 30);
  if (ents.length) {
    parts.push("## Entities", "");
    for (const name of ents) {
      const slug = known.get(name.toLowerCase());
      parts.push(slug ? `- [[${slug}|${name}]]` : `- ${name}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ── topic/<q>.md ─────────────────────────────────────────────────────

export function buildTopicMd(
  q: string,
  factsText: string,
  search: { results?: Array<{ entity?: string; snippet?: string; fact_count?: number }> },
  catalog: CatalogEntry[],
): string {
  const fm = frontmatter({ id: `topic:${q}`, title: `topic: ${q}` });
  const names = catalogNames(catalog);
  const parts: string[] = [fm, "", `# topic: ${q}`, ""];
  parts.push("A topic page just is the query — filed back as a page.", "");
  if (factsText.trim()) {
    parts.push(...factsText.trim().split("\n").map((l) => `> ${linkify(l, names)}`), "");
  } else {
    parts.push("> No matching facts yet.", "");
  }
  const results = (search.results || []).filter((r) => r.entity);
  if (results.length) {
    parts.push("## Matching pages", "");
    for (const r of results.slice(0, 10)) {
      const slug = entityToSlug(r.entity!);
      const snippet = (r.snippet || "").replace(/\n/g, " ").slice(0, 140);
      parts.push(`- [[${slug}]]${snippet ? ` — ${snippet}` : ""}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ── lint.md ──────────────────────────────────────────────────────────

export interface LintFinding {
  fact_id: string;
  entity?: string;
  kind?: string;
  confidence?: string;
  value?: string;
  verdict: string;
  reason?: string;
}

export interface LintReport {
  counts?: Record<string, number>;
  findings?: LintFinding[];
}

const LINT_VERDICT_NOTES: Record<string, string> = {
  escrow: "Raw transcript/agent output stored as facts — T1 episode material. Retracted on apply.",
  ephemeral: "Presence data and stubs — fail the two-week durability test. Retracted on apply.",
  fragment: "Bare auto-extracted phrases carrying no claim. Retracted on apply.",
  unattributed: "Junk-drawer subject 'general', no user reference. Report-only (apply with aggressive).",
};

export function buildLintMd(report: LintReport): string {
  const findings = report.findings || [];
  const counts = report.counts || {};
  const fm = frontmatter({
    id: "lint",
    title: "Lint",
    total: findings.length,
    ...counts,
  });
  const parts: string[] = [fm, "", "# Lint", ""];
  parts.push(
    "Health check over the knowledge graph: what should never have been a fact. "
    + "Applying retracts bi-temporally — nothing is deleted, every retraction is restorable, "
    + "and the transcript escrow keeps all source text regardless.",
    "",
  );
  if (!findings.length) {
    parts.push("*No findings — the graph is clean.*", "");
    return parts.join("\n");
  }
  const byVerdict = new Map<string, LintFinding[]>();
  for (const f of findings) {
    if (!byVerdict.has(f.verdict)) byVerdict.set(f.verdict, []);
    byVerdict.get(f.verdict)!.push(f);
  }
  for (const [verdict, group] of byVerdict) {
    parts.push(`## ${verdict} (${group.length})`, "");
    const note = LINT_VERDICT_NOTES[verdict];
    if (note) parts.push(note, "");
    for (const f of group) {
      const slug = f.entity ? entityToSlug(f.entity.includes(":") ? f.entity : `entity:${f.entity}`) : "";
      const value = (f.value || "").replace(/\n/g, " ");
      const conf = f.confidence ? ` · conf ${f.confidence}` : "";
      parts.push(`- ${slug ? `[[${slug}]] ` : ""}${value}${conf} ^${factToAnchor(f.fact_id)}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ── shares.md / share/<id>.md ────────────────────────────────────────

export interface ShareRow {
  share_token: string;
  entity_id: string;
  mode: string;
  status: string;
  bundle_size?: number | null;
  url: string;
  created_at: number;
  recipient_hint?: string | null;
}

export function buildSharesMd(shares: ShareRow[]): string {
  const fm = frontmatter({ id: "shares", title: "Shares", count: shares.length });
  const parts: string[] = [fm, "", "# Shares", ""];
  parts.push("A share is a scoped slice of the address space. The recipient's link preview is a wiki page.", "");
  for (const s of shares) {
    const created = new Date(s.created_at).toISOString().slice(0, 10);
    parts.push(
      `- [[share/${s.share_token}]] **${s.status}** [[${entityToSlug(s.entity_id)}]] — ${s.mode} · created ${created}`,
    );
  }
  if (!shares.length) parts.push("*No shares yet — create one from any entity page.*");
  parts.push("");
  return parts.join("\n");
}

export function buildShareMd(s: ShareRow): string {
  const fm = frontmatter({
    id: `share:${s.share_token}`,
    status: s.status,
    mode: s.mode,
    entity: s.entity_id,
    created: new Date(s.created_at).toISOString(),
    bundle_size: s.bundle_size ?? undefined,
  });
  const parts: string[] = [fm, "", `# Share: ${humanizeSlug(s.entity_id)}`, ""];
  parts.push("## Pages in scope", "", `- [[${entityToSlug(s.entity_id)}]] — root + 1-hop neighborhood`, "");
  parts.push("Redaction: regex rules from the share scope apply before bundling.", "");
  parts.push(`Link: ${s.url}`, "");
  return parts.join("\n");
}
