/** Offline replay driver for the local guide lane (fmg-live-hints bench).
 *
 * Reads bench turn events (JSONL) on stdin, replays them through the REAL
 * LocalGuideSession — same prompt, tick discipline, dedup and shown-feedback
 * as a live call — and writes every emitted display line to stdout as
 * {"line": "...", "turn_id": "..."} JSONL. The bench-side adapter
 * (fmg-live-hints engine/teleprompter_adapter.py) converts those into
 * scoreable hint events; this side knows nothing about the bench taxonomy.
 *
 * Turn mapping: the seller (speaker contains "Alexander"/"FindMyGap") is ME
 * (mic); everyone else is THEM (system). THEM turns tick — but only the last
 * GUIDE_REPLAY_MAX_TICKS of them (default 6): the harness enforces a hard 30s
 * per-case timeout and the median case has ~30 THEM turns, so earlier turns
 * backfill conversation state without an LLM call. Divergence from live: a
 * hint the live lane would have shown EARLIER in the prefix (and then
 * dedup-suppressed at the scored moment) fires late here instead.
 *
 * Env: ANALYSIS_ENDPOINT / ANALYSIS_API_KEY / ANALYSIS_MODEL (required),
 *      GUIDE_REPLAY_MAX_TICKS (default 6),
 *      GUIDE_REPLAY_INTENT (short goal line),
 *      GUIDE_REPLAY_CONTEXT_FILE (scenario/playbook path; ALWAYS pass a
 *      non-empty scenario in eval runs — an empty one would auto-load the
 *      developer's ~/.sinain/guide-context.md and pollute the run).
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { LocalGuideSession } from "../capture/local-guide.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AnalysisConfig, BurstConfig, VoiceSessionMessage } from "../types.js";

interface BenchTurn {
  event?: string;
  turn_id?: string;
  speaker?: string;
  text?: string;
}

function fail(msg: string): never {
  process.stderr.write(`[guide-replay] ${msg}\n`);
  process.exit(1);
}

async function readTurns(): Promise<BenchTurn[]> {
  const turns: BenchTurn[] = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as BenchTurn;
      if (ev.event === "turn" && (ev.text ?? "").trim()) turns.push(ev);
    } catch { /* skip malformed input lines */ }
  }
  return turns;
}

const isSeller = (speaker: string): boolean =>
  speaker.includes("Alexander") || speaker.includes("FindMyGap");

async function main(): Promise<void> {
  const endpoint = process.env.ANALYSIS_ENDPOINT || "";
  const apiKey = process.env.ANALYSIS_API_KEY || "";
  const model = process.env.ANALYSIS_MODEL || "";
  if (!endpoint || !model) fail("ANALYSIS_ENDPOINT / ANALYSIS_MODEL required");
  const maxTicks = Number(process.env.GUIDE_REPLAY_MAX_TICKS || "6");
  const intent = process.env.GUIDE_REPLAY_INTENT || "";
  let scenario = "";
  if (process.env.GUIDE_REPLAY_CONTEXT_FILE) {
    try {
      scenario = readFileSync(process.env.GUIDE_REPLAY_CONTEXT_FILE, "utf-8");
    } catch (err) {
      fail(`cannot read GUIDE_REPLAY_CONTEXT_FILE: ${String(err).slice(0, 120)}`);
    }
  }
  if (!scenario.trim()) fail("GUIDE_REPLAY_CONTEXT_FILE with a non-empty scenario is required (guards against ~/.sinain/guide-context.md auto-load)");

  const turns = await readTurns();
  if (turns.length === 0) return;

  const analysis: AnalysisConfig = { endpoint, apiKey, model } as AnalysisConfig;
  const burst: BurstConfig = { enabled: false } as BurstConfig;

  // Track which input turn is being processed so emissions attribute to it —
  // each ticking turn is flushed before the next is fed, so this is exact.
  let currentTurnId = "";
  const broadcast = (msg: VoiceSessionMessage): void => {
    if (msg.status !== "live" || !msg.message) return;
    const line = msg.message;
    if (!line.startsWith("THESIS:") && !line.startsWith("HINT:")) return; // status text, not a hint
    process.stdout.write(JSON.stringify({ line, turn_id: currentTurnId }) + "\n");
  };

  // minutes=0 → no seed brief; buffers are never touched on that path.
  const session = new LocalGuideSession(
    analysis, burst,
    {} as unknown as FeedBuffer, {} as unknown as SenseBuffer,
    broadcast,
    () => null, // no embedder offline — semantic dedup degrades to lexical
  );
  const started = await session.start(0, undefined, intent, scenario);
  if (!started.ok) fail(started.error || "session failed to start");

  const themIdx = turns.map((t, i) => ({ t, i })).filter(({ t }) => !isSeller(t.speaker ?? ""));
  const firstTicking = themIdx.length > maxTicks ? themIdx[themIdx.length - maxTicks].i : 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    currentTurnId = turn.turn_id ?? "";
    const source = isSeller(turn.speaker ?? "") ? "mic" as const : "system" as const;
    const tick = source === "system" && i >= firstTicking;
    session.onTranscript(turn.text ?? "", source, tick);
    if (tick) await session.flush();
  }
  await session.flush();
  session.stop();
}

void main().then(() => process.exit(0), (err) => fail(String(err).slice(0, 300)));
