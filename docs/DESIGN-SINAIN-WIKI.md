# DESIGN: Sinain Wiki — the knowledge API as a live LLM wiki

**Status:** Draft for design review (brainstorm converged 2026-07-10)
**Inspiration:** karpathy's "live LLM wiki" pattern — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
**Related docs:** `docs/knowledge-ui-design.md` (Living Confluence v1), `docs/DESIGN-MEMORY-V2.md`, `docs/KNOWLEDGE-API.md`

---

## 1. Thesis

Sinain's knowledge system and karpathy's "live LLM wiki" are the same idea with the layers inverted. His pattern: a folder of LLM-maintained markdown files (`[[wikilinks]]`, YAML frontmatter, `index.md` catalog, append-only `log.md`, a self-describing schema file), with three operations — **ingest, query, lint** — and Obsidian as the human's viewer.

We already have every layer, just not in wiki shape:

| karpathy layer | sinain equivalent today |
|---|---|
| `raw/` immutable sources | T1 episodes (`episodes.jsonl`, append-only, provenance via `episode_ids`) |
| wiki layer (LLM-owned markdown) | LLM-rendered entity pages (`page_renderer.py`) — rendered to JSON on demand, cached in `web.db`, never persisted as files |
| schema layer (`CLAUDE.md`/`AGENTS.md`) | `docs/DESIGN-MEMORY-V2.md` + the render prompt — not co-located with the data |
| `index.md` catalog | `GET /knowledge/entities` |
| `log.md` append-only record | episodes + `web.db` logs, no markdown form |
| `[[wikilinks]]` | ref-valued triples + `backrefs()` — the edges exist, not spelled as wikilinks |
| ingest / query / lint | distillation+compaction / `/knowledge/query` / confidence decay + `playbook_curator` |

**Core decision: the wiki is a protocol, not a folder.** No materialized files, no sync, no staleness. The vault is *virtual* — every page rendered on demand from the stores (Oxigraph triplestore + memory_v2 episodes). Anything that speaks "wiki" — an LLM over MCP, the web UI, `curl` — sees the same markdown bytes.

**Framing: we are not adding a wiki next to the knowledge API — we are concluding a wiki is the right *shape* for the knowledge API.** The wiki routes are the knowledge API's next version, mounted at `/knowledge/*`. Markdown vaults (folders of `.md` files) exist only as an **interchange format** at the boundary (import/export), never as the live store.

The engine does not change. Oxigraph stays (deliberate choice, do not revisit). memoryd stays the single writer. This design is a new *surface* over existing machinery.

---

## 2. Address space

One canonical path per page, identical everywhere. Identity and location are distinguished by prefix only:

- **`sinain://<path>`** — location-independent identity. Used in MCP resource URIs, share bundles, and any cross-machine reference. Same page on every machine (content-addressed slugs make this real — the property that already powers concept transfer).
- **`GET http://localhost:9500/knowledge/<path>`** — where this machine serves it. Resolution rule (one line in WIKI.md): *resolve `sinain://X` by prepending your local mount.*
- **`[[slug]]`** — how pages reference each other internally. Wikilinks are relative; neither prefix ever appears inside page bodies.

No separate namespace (`/wiki`, `/sinain-wiki`) — rejected during design. The `.md`-suffixed file-shaped paths cannot collide with existing `/knowledge/*` routes, so both generations coexist on the same mount during migration.

### Virtual pages

| path | rendered from | notes |
|---|---|---|
| `sinain://WIKI.md` | static-ish template + live stats | The self-describing schema layer: conventions, page types, available tools. First thing any connecting LLM reads. Also served at `sinain://AGENTS.md` (same bytes) so agent frameworks that auto-discover `AGENTS.md` find it unprompted. |
| `sinain://index.md` | entity list grouped by the five typed domains (`endeavors, people, preferences, decisions, procedures`) | The catalog. Always current by construction — it *is* a query, so karpathy's "update index on every ingest" chore doesn't exist. |
| `sinain://entity/<slug>.md` | `page_renderer.py` with `format=md` | Frontmatter + fact bullets with `^f-id` anchors + `[[wikilinks]]` from ref triples and `backrefs()`. See §3. |
| `sinain://log.md?since=&limit=` | T1 episodes via memoryd | karpathy's append-only log, virtually paginated — a real file grows forever; ours can't. Entry convention: `## [2026-07-10T14:02] ingest \| session-xyz`. Breakpoint/return episode kinds give it structure for free. |
| `sinain://episode/<id>.md` | single T1 episode | Provenance drill-down target: fact bullets cite their `episode_ids` as links here. |
| `sinain://topic/<q>.md` | `/knowledge/query` + `/knowledge/search` | karpathy's "file good answers back as pages" — a topic page just *is* the query, cached by `tx_watermark`. |
| `sinain://share/<id>.md` | share scope through the page renderer | A share rendered as a wiki page: exactly which pages/facts are in the bundle. The recipient's link preview is a wiki page. |
| `sinain://shares.md` | `web.db` shared_docs | Share management as a page. |
| `sinain://bookmarks.md` | `web.db` bookmarks | Optional — favorites/recent/archive as a page (or injected into the home render; open question §9). |

The two pages that rot in file-based wikis (`index.md`, `log.md`) are maintenance-free here: they are views, not artifacts.

### Scoping

"Render this address space through this filter" is one concept serving three features: **share scopes** (a share = a scoped slice of the address space), **persona layers** (`layers[]` from memory_v2 — scope is a property of the *request*, not of which folder a file landed in), and **vault export scopes** (§7). Nothing sensitive ever sits on disk as plaintext markdown.

---

## 3. Page format (the core contract — nail this first)

Everything hangs off this format: the MCP and the UI will speak it forever, and vault export/import round-trips through it. Draft, for critique:

```markdown
---
id: entity:igor
type: person
title: Igor Gerasimov
aliases: [Igor, geravant]          # from skos:altLabel — Obsidian resolves alias links natively
domain: people
tags: [founder, sinain]
created: 2026-05-14
confidence: 0.92                    # decayed, at render time
sources: [ep-8fa21, ep-9c03d]      # episode provenance for the page's core facts
---

# Igor Gerasimov

One-paragraph LLM summary (from the existing page render prompt).

## Facts
- Works at [[acme]] as founding engineer ^f-3fa2c1
- Prefers deterministic pipelines over LLM-in-the-loop integration ^f-77b2e0
- worksAt:: [[acme]]
- founded:: [[sinain]]

## Related
- [[sinain]] — founder (backref)
- [[memory-v2]] — designed (backref)

## History
- ~~Works at [[initech]]~~ (valid 2025-01 → 2026-03, superseded by ^f-3fa2c1)
```

Format rules:

1. **Fact bullets carry block anchors** (`^f-<id>`, Obsidian block-ref syntax; `f-<id>` = the content-addressed fact slug). These are simultaneously: (a) round-trip handles for LLM edits via MCP (`annotate` targets a fact id), (b) the web UI's edit handles (delete/restore buttons hang off anchors), (c) stable across machines.
2. **Refs are `[[wikilinks]]`**; typed edges use Dataview inline-field syntax `worksAt:: [[acme]]` — Obsidian-graph-visible, Dataview-queryable, trivially machine-parseable. Natural home for `link_extraction.py`'s `auto:worksAt/founded/investedIn/advises` edges (the file is literally adapted from a markdown-wikilink mechanism; this closes that loop).
3. **Bi-temporality**: current facts in the body; superseded facts in `## History` with validity windows, strikethrough. The page shows the story; the store keeps the truth.
4. **`## Related`** = `backrefs()` (VAET-style reverse index), giving every page inbound-link context.
5. Frontmatter fields map 1:1 to triples (`type`, `name`, `alias`, `tag`, `domain`, `created_at`, `confidence`).

Provenance navigation falls out of wiki-native linking: fact → source episode (`sinain://episode/<id>.md`) — navigation the current UI doesn't have at all.

---

## 4. WIKI.md — the schema layer (the sleeper win)

Served at the vault root (`sinain://WIKI.md` ≡ `sinain://AGENTS.md`). Contents: page types and conventions (§3), the address space and resolution rule (§2), available MCP tools (§5), and live stats (entity/fact/episode counts, last ingest).

This makes the vault a **self-describing substrate**: any LLM — including Claude Code pointed at the MCP — reads `WIKI.md` and can ingest/query/lint the wiki with zero sinain-specific knowledge. Sinain becomes "some wiki" to the agent.

---

## 5. MCP surface (`sinain-wiki` server)

Server name `sinain-wiki`, so tools read as `mcp__sinain-wiki__*` and an agent's tool list tells the story. Thin proxy over sinain-core routes / memoryd ops.

**Resources** — every virtual page, URI'd as `sinain://...`. Listing resources = "ls the vault"; reading = render. An LLM browsing resources is indistinguishable from an LLM browsing a folder.

**Tools** (karpathy's three operations, plus edit):

| tool | maps to | notes |
|---|---|---|
| `search(q)` | `/knowledge/search` | returns matching page URIs + snippets |
| `ingest(text, source)` | memoryd ingest → distill → facts | response lists which virtual pages changed (his "one source touches 10–15 pages") |
| `lint()` | new memoryd op | orphan pages, contradictions, stale claims — surfaces decayed-confidence + supersession data we already compute |
| `annotate(fact_id, action)` | retract/restore/supersede via `retract.py` | an LLM "edits a bullet" and it round-trips to a proper bi-temporal op |
| `import_vault(path)` / `export_vault(path, scope)` | §7 | local-path variants of vault interchange |

---

## 6. Web UI: replaced wholesale

The current KG web UI has **no file of its own** — it is inline HTML/CSS/JS strings inside `sinain-core/src/server.ts` (see Appendix A for the full map). The ~1,400-line inline "Living Confluence" SPA (lines ~158–1580) is retired and replaced with: **router + markdown renderer + dropzone**, with two custom render rules — `[[slug]]` → navigate to `/knowledge/ui/entity/<slug>`, and `^f-id` anchors → attach delete/restore action buttons calling the existing retract/restore endpoints. `/knowledge/ui-legacy` dies.

| current UI | becomes |
|---|---|
| Home (favorite/recent/archive rows) | rendered `sinain://index.md` (+ bookmarks section injected from `web.db`, or `sinain://bookmarks.md`) |
| Entity page (LLM sections, FactBullets, retraction UI) | rendered `sinain://entity/<slug>.md`; anchors are the edit handles |
| Topic page | rendered `sinain://topic/<q>.md` |
| Import dropzone | stays; UI skin over `ingest` (+ vault zip upload, §7) |
| Shares management | rendered `sinain://shares.md` + `sinain://share/<id>.md` |
| Graph tree (`renderGraphTree`) | Related sections + wikilink navigation; Obsidian's graph view covers force-layout for free if ever needed via export |

Three notations, one page: `sinain://entity/igor.md` (canonical) ≡ `GET /knowledge/entity/igor.md` (transport) ≡ `/knowledge/ui/entity/igor` (human view). No drift possible between what an LLM sees and what the human sees — one renderer.

`web.db` stays exactly what it is: UI state (bookmarks, page cache keyed on `tx_watermark`, retraction undo, share links), never knowledge.

---

## 7. Sharing (kept) and vault interchange (new)

### Sharing
The transfer payload stays `sinain-concept/v1` bundles (verbatim triples + regex redaction + WebRTC/peerjs + share links) — mechanism unchanged. What changes is the surface: a share is a **scoped slice of the address space** (§2), managed and previewed as wiki pages. On import, received triples land as today, and the corresponding `sinain://entity/*.md` pages simply exist on the recipient's side — content-addressed slugs mean addresses match across machines. Two sinains sharing concepts are exchanging wiki pages with stable URLs.

### Import: user's existing LLM wiki / Obsidian vault → memory
Treat their vault through karpathy's own lens — **their wiki pages are our raw sources**:

1. **Escrow losslessly**: each `.md` file → T1 episode (`source=import`, meta carries filename + frontmatter verbatim). Whatever extraction misses, the original text stays retrievable — exactly like transcripts today.
2. **Deterministic pass** (no LLM, no variance — `knowledge_integrator` philosophy): frontmatter → triples; filename/title → entity; `[[wikilinks]]` → ref edges; `worksAt:: [[x]]` inline fields → typed edges; bullets → candidate facts with subject = the page's entity.
3. **LLM distillation pass** for freeform prose — `session_distiller` fed pages instead of transcripts, source episode as provenance on every fact.
4. **Idempotent**: content-addressed slugs mean re-importing the same or an updated vault dedups/supersedes rather than duplicating.

Surfaces: MCP `import_vault(path)`; zip upload on the dropzone; `POST /knowledge/import?format=vault` as sibling of the legacy JSON import.

### Export: memory → a folder of markdowns
The virtual wiki, materialized once: walk the address space (through a scope filter), write every page, zip. `WIKI.md`, `index.md`, all entity pages, `log.md` snapshot — an Obsidian-openable vault with zero extra format work. Export inherits **scoping** and **redaction** from the sharing machinery (a folder of markdown on disk is the least private artifact we produce). Surfaces: `GET /knowledge/export?format=vault`; MCP `export_vault(path, scope)`.

### The symmetry
Import and export are inverses through the store, not through bytes: `their vault → episodes + facts → our virtual pages → exported vault`. The round trip is *normalized*, which is the product: feed us a messy hand-grown wiki, get back consistent frontmatter, resolved aliases, deduped facts, provenance links — lint as a side effect of passing through. Import = onboarding from karpathy-style wikis; export = the no-lock-in story ("your memory is always a folder of markdown away"). Both matter for trust in a memory product.

---

## 8. What actually gets built (small, because the pieces exist)

1. `page_renderer.py` gains `format=md` — already an open question in `knowledge-ui-design.md:662`; the one real rendering change.
2. `server.ts` routes for the virtual pages under `/knowledge/*` — mostly existing handlers reformatted to markdown (`index.md` = entities endpoint, `log.md` = episodes endpoint).
3. `WIKI.md` template — mostly writing, not code.
4. MCP server `sinain-wiki` — thin proxy: resources + 4–6 tools.
5. SPA re-skin: markdown renderer + router + the two custom rules.
6. Vault import (escrow → deterministic parse → distill) and export (materialize + zip), sharing scope/redaction reused.

Suggested phasing: **P1** = page format + `format=md` + virtual routes + `WIKI.md`; **P2** = MCP server + SPA re-skin; **P3** = vault import/export. The page format (§3) is designed once, first — with anchors and frontmatter IDs in from day one even before anything reads them, so later phases require no renaming.

---

## 9. Open questions

- **Bullet→fact aggressiveness on import**: start conservative (structure deterministic, prose via LLM) — escrowed episodes make it safe to re-extract later with better rules. Confirm.
- **Bookmarks**: injected section on the home render vs. a `sinain://bookmarks.md` page.
- **History growth**: does `## History` bloat pages over months, or do superseded facts overflow to a per-entity archive page?
- **Persona layers in export**: per-layer scopes exist at render time; decide whether export refuses mixed-layer scopes or splits into per-layer vaults.
- **Slug ↔ filename mapping** for export/import: entity IDs like `entity:foo` contain `:` (illegal in filenames) — folder mapping (`entity/foo.md`) is implied by the address space, but confirm collisions/aliasing rules.
- **Which store projects first**: production facts (Oxigraph) vs. memory_v2 tiers mid-migration — the page renderer must serialize both to one page; the wiki is a forcing function for that seam.

## 10. Explicitly rejected

- **Materialized vault as the live store** ("a million markdown files") — files only at the interchange boundary.
- **Bidirectional file-watcher sync** with a maintained on-disk mirror — superseded by the virtual design; edits flow through MCP `annotate`/`ingest` instead.
- **Separate `/wiki` or `/sinain-wiki` HTTP namespace** — the wiki *is* the knowledge API; mounted at `/knowledge/*`.
- **`sinain-wiki://` scheme** — the scheme is the identity; `sinain://` suffices.
- **Vault as source of truth with Oxigraph demoted** — forfeits bi-temporality, persona layers, SPARQL; the workflow benefits arrive without the migration.

---

## Appendix A: current KG web UI — implementation map

The entire UI ships as inline strings in **`sinain-core/src/server.ts`** (~3,544 lines) — a deliberate zero-build single-file deploy. Key locations (as of 2026-07-10, branch `feat/wsm-attention-cockpit`):

### Frontend (inline HTML/CSS/JS strings)
- `server.ts:21–155` — `KNOWLEDGE_UI_HTML`: **legacy** flat fact browser (search box, domain filter, card list, export/import textarea). Served at `/knowledge/ui-legacy` (`server.ts:2973`).
- `server.ts:158–1580` — **V2 "Living Confluence" SPA** (client-side router + views):
  - `:439–448` — client route table: `/knowledge/ui` (home), `/knowledge/ui/shares`, `/knowledge/ui/entity/<id>`, `/knowledge/ui/topic/<q>`
  - `~:866–890` — home view: bookmark rows (favorite/recent/archive) + import dropzone
  - `~:1084` — `renderEntityPage` client fn: fetches `/knowledge/page`, renders summary + themed sections + FactBullets
  - `~:1198` — `renderGraphTree`: lazy tree via `/knowledge/graph/children` (pure DOM, no viz lib — v1 deliberately rejected D3 force layout, `knowledge-ui-design.md:20`)
  - `~:1310` / `~:1345` — retraction delete / restore UI
  - `~:1429` — topic page (combines `/knowledge/query` + `/knowledge/search`)
  - `~:606–1000` — cross-machine concept sharing UI: share links, WebRTC/peerjs peer transfer, auto-import of received bundles
- `server.ts:2973–2995` — HTTP routes serving the SPA shell (`/knowledge/ui-legacy`, `/knowledge/ui`, `/knowledge/ui/*`).

### Backend routes consumed by the UI (all in `server.ts`, handler wiring in `index.ts`)
`GET /knowledge` (portable doc dump), `/knowledge/facts`, `/knowledge/entities`, `/knowledge/as-of`, `/knowledge/query`, `/knowledge/search`, `/knowledge/page` (LLM-rendered page via `page_renderer.py`), `/knowledge/graph/children`, bookmarks CRUD, `/knowledge/concepts/export|import`, `DELETE /knowledge/facts/:id` + restore, `/knowledge/shares` CRUD, `GET /memory/episodes` (T1 via memoryd unix socket).

### Supporting stores
- `sinain-core/src/web-db/schema.ts` + `store.ts` — `web.db` (SQLite): `user_bookmarks`, `page_cache` (keyed `(entity_id, tx_watermark)`), `retraction_undo`/`retraction_log`, `concept_imports`, `search_log`, `shared_docs`.
- `sinain-hud-plugin/sinain-memory/rdf_store.py` — Oxigraph triplestore (production facts).
- `sinain-hud-plugin/sinain-memory/memory_v2/` + `memoryd.py` — T1 episodes / T2 typed facts.
- `sinain-hud-plugin/sinain-memory/page_renderer.py` — LLM page rendering (the `format=md` insertion point).

### Design lineage
`docs/knowledge-ui-design.md` (676 lines) is the authoritative v1 spec for the current SPA: UX flow, full API surface, `web.db` schema, component tree, LLM page-generation prompt, concept-transfer format. This document supersedes its *presentation* layer while keeping its API and storage decisions.
