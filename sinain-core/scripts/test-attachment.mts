import { AttachmentCoordinator, type ActiveSession } from "../src/agent-sessions/attachment.js";
import { AgentSessionRegistry } from "../src/agent-sessions/registry.js";

const results: Array<[string, boolean, string?]> = [];

function check(name: string, run: () => void): void {
  try {
    run();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    results.push([name, false, note]);
    console.log(`FAIL  ${name} — ${note}`);
  }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function harness(active: ActiveSession[]) {
  const registry = new AgentSessionRegistry();
  const changed: string[] = [];
  const coordinator = new AttachmentCoordinator(registry, () => active, (threadId) => changed.push(threadId));
  const event = (sessionId: string, ts: number, cwd = "/work/project") => {
    registry.handleEvent({ session_id: sessionId, source: "codex", hook_event_name: "SessionStart", cwd, ts });
    coordinator.sync();
  };
  return { registry, coordinator, changed, event };
}

check("single candidate attaches", () => {
  const h = harness([{ id: "w1", threadId: "thread-one", label: "Work", startTs: 100, paused: false }]);
  h.event("a1", 200);
  equal(h.registry.snapshot()[0].threadId, "thread-one");
});

check("cwd basename resolves ambiguity", () => {
  const h = harness([
    { id: "w1", threadId: "thread-one", label: "Mail", startTs: 100, paused: true },
    { id: "w2", threadId: "thread-project", label: "Project release", startTs: 120, paused: false },
  ]);
  h.event("a1", 200, "/work/project");
  equal(h.registry.snapshot()[0].threadId, "thread-project");
});

check("unresolved ambiguity stays orphaned", () => {
  const h = harness([
    { id: "w1", threadId: "thread-one", label: "Mail", startTs: 100, paused: true },
    { id: "w2", threadId: "thread-two", label: "Docs", startTs: 120, paused: false },
  ]);
  h.event("a1", 200, "/work/project");
  equal(h.registry.snapshot()[0].threadId, undefined);
});

check("launch before span stays orphaned", () => {
  const h = harness([{ id: "w1", threadId: "thread-one", label: "Work", startTs: 300, paused: false }]);
  h.event("a1", 200);
  equal(h.registry.snapshot()[0].threadId, undefined);
});

check("working and waiting runs count", () => {
  const h = harness([{ id: "w1", threadId: "thread-one", label: "Work", startTs: 100, paused: false }]);
  h.event("a1", 200);
  h.event("a2", 210);
  h.registry.markWaiting("a2", "npm publish", 220);
  h.coordinator.sync();
  equal(h.coordinator.augmentsFor("thread-one").working, 2);
});

check("done run produces deterministic receipt", () => {
  const start = Date.now();
  const h = harness([{ id: "w1", threadId: "thread-one", label: "Work", startTs: start - 100, paused: false }]);
  h.event("a1", start, "/work/project");
  h.registry.handleEvent({
    session_id: "a1", source: "codex", hook_event_name: "Stop",
    message: "published bridge v0.3", ts: start + 61_000,
  });
  h.coordinator.sync();
  equal(h.coordinator.augmentsFor("thread-one"), {
    working: 0,
    receipts: ["agent: codex — project — published bridge v0.3 (2m)"],
  });
});

check("wrap detaches live run without same-thread reattachment", () => {
  const active: ActiveSession[] = [
    { id: "w1", threadId: "thread-one", label: "Work", startTs: 100, paused: false },
  ];
  const h = harness(active);
  h.event("a1", 200);
  h.coordinator.onWrap("thread-one");
  h.coordinator.sync();
  equal(h.registry.snapshot()[0].threadId, undefined);

  active.splice(0, 1, { id: "w2", threadId: "thread-new", label: "Work", startTs: 150, paused: false });
  h.coordinator.sync();
  equal(h.registry.snapshot()[0].threadId, "thread-new");
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
