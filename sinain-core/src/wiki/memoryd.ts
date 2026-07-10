/**
 * Thin memoryd client for the wiki routes — newline-framed JSON ops over
 * the resident worker's unix socket (same protocol as /memory/episodes in
 * server.ts). Fail-open: callers render pages without episode data when
 * memoryd is down.
 */
import { connect } from "node:net";

export interface EpisodeQuery {
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  includeText?: boolean;
}

function memorydSockPath(): string {
  return process.env.SINAIN_KG_SOCK || "/tmp/sinain-kg.sock";
}

async function memorydOp(payload: Record<string, unknown>): Promise<any> {
  const line = JSON.stringify(payload) + "\n";
  return await new Promise((resolve, reject) => {
    const sock = connect(memorydSockPath());
    let buf = "";
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error("memoryd timeout")); });
    sock.on("error", reject);
    sock.on("connect", () => sock.write(line));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      }
    });
  });
}

/** Fetch T1 episodes; returns [] when memoryd is unavailable. */
export async function fetchEpisodes(query: EpisodeQuery): Promise<any[]> {
  try {
    const parsed = await memorydOp({
      op: "episodes",
      query: query.q || "",
      since: query.since || "",
      until: query.until || "",
      limit: Math.min(query.limit ?? 50, 200),
      include_text: !!query.includeText,
    });
    if (parsed && Array.isArray(parsed.episodes)) return parsed.episodes;
    return [];
  } catch {
    return [];
  }
}

/** Fetch one episode by id (memoryd has no id filter — fetch a window and
 *  pick; include_text so the escrow excerpt is available). */
export async function fetchEpisode(id: string): Promise<any | null> {
  const episodes = await fetchEpisodes({ limit: 200, includeText: true });
  return episodes.find((e) => e && e.id === id) ?? null;
}
