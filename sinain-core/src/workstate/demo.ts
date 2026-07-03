// Standalone P1.5 demo — parallel work-states (the thread bank, §9).
//
// Simulates a day of switching between 3–4 projects (each matched against YOUR
// real KG topics), then prints the attention-ranked thread board: which project
// most warrants your attention right now, given staleness-vs-cadence + assist
// value + difficulty. Deterministic, offline.
//
//   npx tsx src/workstate/demo.ts          (from sinain-core/)

import { homedir } from "node:os";
import { join } from "node:path";
import { EmbeddingService } from "../embedding/service.js";
import { FeedBuffer } from "../buffers/feed-buffer.js";
import { SenseBuffer } from "../buffers/sense-buffer.js";
import { WorkStateEngine, formatLine, sparkline } from "./engine.js";
import { deriveProject } from "./extractor.js";
import type { RawFeatures, ThreadBoardEntry } from "./types.js";

const memoryDir = process.env.SINAIN_MEMORY_DIR || join(homedir(), ".sinain", "memory");
const H = 3_600_000;
const M = 60_000;

// Four projects attended at different times — a stale, left-stuck one (D), a
// couple of mid-day threads (B, C), and the one you're on now (A).
interface Visit { name: string; agoMs: number; f: Partial<RawFeatures> & { app: string } }
const VISITS: Visit[] = [
  {
    name: "whisper build — left stuck, 30h ago", agoMs: 30 * H,
    f: { app: "iTerm2", windowTitle: "whisper build",
      surfaceText: "Error: cmake failed undefined symbol build failed again retry whisper-server compile error",
      recurringIssue: true, dwellMs: 240_000, switchRate: 0.5 },
  },
  {
    name: "teamcity migration — 8h ago", agoMs: 8 * H,
    f: { app: "Google Chrome", windowTitle: "TeamCity",
      surfaceText: "teamcity migration timeline build configuration agent pool project settings", switchRate: 1 },
  },
  {
    name: "gemma hackathon — 3h ago", agoMs: 3 * H,
    f: { app: "Zed", windowTitle: "hackathon",
      surfaceText: "cerebras google deepmind gemma hackathon plan submission demo", switchRate: 0.8 },
  },
  {
    name: "sinain anchoring — now (active)", agoMs: 5 * M,
    f: { app: "Zed", windowTitle: "region-tracker.ts",
      surfaceText: "phrase-level anchoring for the sinain project region tracker fuse anchor OCR line bbox", switchRate: 0.4 },
  },
];

function fill(app: string, p: Partial<RawFeatures>, ts: number): RawFeatures {
  return {
    ts, app, windowTitle: p.windowTitle, surfaceText: p.surfaceText || "",
    switchRate: p.switchRate ?? 0, dwellMs: p.dwellMs ?? 30_000,
    recurringIssue: p.recurringIssue ?? false, vadDensity: p.vadDensity ?? 0,
    activityHint: /term/.test(app) ? "coding" : /chrome|safari/.test(app) ? "reading" : "coding",
    sceneCut: false,
    projectKey: deriveProject(app, p.windowTitle || "").key,
    projectLabel: deriveProject(app, p.windowTitle || "").label,
  };
}

function humanAge(ms: number): string {
  if (ms < H) return `${Math.round(ms / M)}m`;
  if (ms < 24 * H) return `${(ms / H).toFixed(0)}h`;
  return `${(ms / (24 * H)).toFixed(0)}d`;
}
function needBar(v: number): string {
  const n = Math.round(v * 10);
  return "█".repeat(n) + "·".repeat(10 - n);
}

async function main(): Promise<void> {
  const emb = new EmbeddingService();
  emb.loadAsync();
  process.stdout.write("loading embedding model");
  const deadline = Date.now() + 30_000;
  while (!emb.ready && Date.now() < deadline) { process.stdout.write("."); await new Promise((r) => setTimeout(r, 500)); }
  console.log(emb.ready ? " ready\n" : " TIMEOUT\n");

  const engine = new WorkStateEngine({
    senseBuffer: new SenseBuffer(30), feedBuffer: new FeedBuffer(100),
    embeddingService: emb, memoryDir,
  });
  engine.start(); // loads the KG-pretrained prior
  engine.stop(); // ...then disable the live poll (we drive observe() by hand)
  console.log();

  const now = Date.now();
  // Replay the visits in chronological order; 3 observations each so routing
  // hysteresis (2 ticks) actually switches threads.
  const ordered = [...VISITS].sort((a, b) => b.agoMs - a.agoMs);
  for (const v of ordered) {
    const at = now - v.agoMs;
    for (let i = 0; i < 3; i++) await engine.observe(fill(v.f.app, v.f, at + i * 1000), at + i * 1000);
  }

  const view = engine.getView(now);
  console.log("ACTIVE THREAD:");
  if (view.active) console.log("  " + formatLine(view.active.vector, view.active.decision));

  console.log("\nATTENTION BOARD (ranked by need — which project most wants you now):\n");
  console.log("  need        temp  age   stuck  action               project");
  console.log("  " + "─".repeat(78));
  for (const t of view.board) {
    const mark = t.isActive ? "▸" : " ";
    console.log(
      `${mark} ${needBar(t.needScore)} ${t.temperature.toFixed(2)}  ${humanAge(t.ageMs).padStart(3)}  ` +
      `${t.stuckness.toFixed(2)}   ${t.action.padEnd(20)} ${t.label}` +
      `  ${sparkline(t.trajectory)}`,
    );
    if (t.why.length) console.log(`    └ ${t.why.join("; ")}`);
  }
  console.log();
}

void main();
