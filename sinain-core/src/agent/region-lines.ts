import type { ContextWindow, RawRegion } from "../types.js";

const REGION_ACTIONS = new Set(["fix", "explain", "research"]);

/** One OCR line offered to a model, with the geometry to anchor an eye to it. */
export interface PromptLine {
  bbox: [number, number, number, number];
  text: string;
  frameSize: [number, number];
  app: string;
  display: number;
  ocr: string; // source event's full OCR (spawn context)
}

/**
 * Build the numbered "[L<id>] text" line list a model picks region anchors from
 * — the current app's freshest OCR lines (newest-first), deduped. Both the SLM
 * lane and the main analyzer use this so a region anchored to a line resolves
 * identically (and gets the same stable id) regardless of which lane found it.
 */
export function buildLineList(ctx: ContextWindow, maxLines = 40): { prompt: string; lines: PromptLine[] } {
  const cur = (ctx.currentApp || "").toLowerCase().trim();
  const lines: PromptLine[] = [];
  const seen = new Set<string>();
  for (const e of ctx.screen) { // newest-first
    const eApp = (e.meta.app || "").toLowerCase().trim();
    if (cur && eApp && eApp !== cur) continue;
    const fs = (e.frameSize && e.frameSize.length === 2) ? e.frameSize as [number, number] : undefined;
    if (!fs || !e.ocrLines?.length) continue;
    for (const l of e.ocrLines) {
      const text = (l.text || "").trim();
      if (text.length < 3 || !Array.isArray(l.bbox) || l.bbox.length !== 4) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        bbox: l.bbox as [number, number, number, number],
        text, frameSize: fs,
        app: e.meta.app || ctx.currentApp,
        display: e.meta.screen,
        ocr: e.ocr || "",
      });
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  return { prompt: lines.map((l, i) => `[L${i}] ${l.text}`).join("\n"), lines };
}

/**
 * Resolve a model's raw `{line, issue, tip, action}` objects to pre-resolved
 * RawRegions against the line list. Tolerates the id as 2/"2"/"L2". The model's
 * own `issue` is used when present; `placeholder` (if given) is only a fallback
 * for when the model omitted a description.
 */
export function resolveLineRegions(
  parsedRegions: any,
  lines: PromptLine[],
  opts: { provisional?: boolean; maxRegions?: number; placeholder?: (l: PromptLine) => string } = {},
): RawRegion[] | undefined {
  if (!Array.isArray(parsedRegions) || parsedRegions.length === 0 || lines.length === 0) return undefined;
  const max = opts.maxRegions ?? 3;
  const out: RawRegion[] = [];
  for (const r of parsedRegions) {
    const li = parseInt(String(r?.line ?? r?.lineId ?? "").replace(/[^0-9]/g, ""), 10);
    if (!Number.isInteger(li) || li < 0 || li >= lines.length) continue;
    const ln = lines[li];
    const modelIssue = typeof r?.issue === "string" ? r.issue.trim() : "";
    // Prefer the model's own description; fall back to the templated placeholder
    // only when the model didn't supply one (so the SLM lane can pass a
    // placeholder as a safety net while still using its real prose when present).
    const issue = modelIssue || (opts.placeholder ? opts.placeholder(ln) : "");
    if (!issue) continue;
    out.push({
      issue: issue.slice(0, 200),
      tip: (typeof r?.tip === "string" && r.tip.trim() ? r.tip.trim() : "Engage with this on screen.").slice(0, 300),
      action: REGION_ACTIONS.has(r?.action) ? r.action : undefined,
      bbox: ln.bbox,
      frameSize: ln.frameSize,
      anchorText: ln.text,
      sourceOcr: ln.ocr,
      app: ln.app,
      display: ln.display,
      provisional: opts.provisional || undefined,
    });
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/** Templated provisional label from app + line content — clean and instant, so
 *  the SLM's weak prose never reaches the user; the analyzer overwrites it. */
export function placeholderFor(app: string, lineText: string): string {
  const a = (app || "").toLowerCase();
  const t = (lineText || "").toLowerCase();
  if (/error|exception|traceback|fail|undefined|cannot|denied|\bnull\b|warning/.test(t)) return "Checking this error…";
  if (/mail|outlook|gmail|spark|airmail|superhuman/.test(a)) return "Thinking about this email…";
  if (/slack|discord|telegram|messages|whatsapp|signal/.test(a)) return "Reading this message…";
  if (/zed|xcode|intellij|idea|vscode|code|pycharm|sublime|vim|nvim|terminal|iterm|warp/.test(a)) return "Looking at this code…";
  if (/chrome|safari|firefox|arc|edge|brave/.test(a)) return "Reading this page…";
  return "Thinking about this…";
}
