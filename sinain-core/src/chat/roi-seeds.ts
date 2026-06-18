// ROI seed store for the desktop-app chat lane.
//
// When the chat agent is a desktop app (Claude/ChatGPT), core composes the
// region context (buildRegionTaskText) and stashes it here under a minted id.
// The deep link / clipboard pointer that opens the app carries only that id;
// the app pulls the full seed (text + optional cropped image) back via the
// sinain_roi MCP tool → GET /roi/pending?id. Keeping the payload off the URL
// avoids the ~14k claude:// cap and lets images ride through.
//
// In-process singleton: routeDesktopChat (index.ts) writes, the /roi/pending
// endpoint (server.ts) reads — same process, so no HTTP round-trip to store.

import { randomUUID } from "node:crypto";

export interface RoiSeed {
  id: string;
  regionId: string;
  seed: { text: string; image?: string; imageMimeType?: string };
  ts: number;
}

const TTL_MS = 10 * 60_000;

class RoiSeedStore {
  private seeds = new Map<string, RoiSeed>();
  private lastId: string | null = null;

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, s] of this.seeds) if (s.ts < cutoff) this.seeds.delete(id);
  }

  put(text: string, regionId = "", image?: { data: string; mimeType?: string }): string {
    this.prune();
    const id = `roi-${randomUUID()}`;
    const seed: RoiSeed["seed"] = { text };
    if (image) { seed.image = image.data; seed.imageMimeType = image.mimeType; }
    this.seeds.set(id, { id, regionId, seed, ts: Date.now() });
    this.lastId = id;
    return id;
  }

  get(id?: string | null): RoiSeed | null {
    this.prune();
    const key = id || this.lastId;
    return key ? this.seeds.get(key) ?? null : null;
  }

  /** Replace a stored seed's text in place (async knowledge enrichment): the
   *  app launches instantly with the fast seed, and this upgrades it to the
   *  full seed before the agent's sinain_roi pull arrives. No-op if expired. */
  update(id: string, text: string): void {
    const s = this.seeds.get(id);
    if (s) s.seed.text = text;
  }
}

export const roiSeeds = new RoiSeedStore();
