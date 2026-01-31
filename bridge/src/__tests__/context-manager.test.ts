import { describe, it, beforeEach, expect } from "vitest";
import { ContextManager } from "../context-manager.js";

describe("ContextManager", () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager();
  });

  it("adds entries and tracks size", () => {
    cm.add("hello", "test");
    cm.add("world", "test");
    expect(cm.size).toBe(2);
  });

  it("returns entries via get()", () => {
    cm.add("first", "mic");
    cm.add("second", "system");
    const entries = cm.get();
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("first");
    expect(entries[0].source).toBe("mic");
    expect(entries[1].text).toBe("second");
  });

  it("getSince filters by timestamp", async () => {
    cm.add("old", "test");
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    cm.add("new", "test");
    const recent = cm.getSince(cutoff);
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toBe("new");
  });

  it("clear removes all entries", () => {
    cm.add("a", "test");
    cm.add("b", "test");
    cm.clear();
    expect(cm.size).toBe(0);
    expect(cm.get()).toHaveLength(0);
  });

  it("summarize returns formatted text", () => {
    cm.add("hello world", "mic");
    const summary = cm.summarize();
    expect(summary).toContain("hello world");
    expect(summary).toContain("mic");
  });

  it("summarize returns placeholder when empty", () => {
    expect(cm.summarize()).toBe("(no recent context)");
  });

  it("summarize respects maxEntries", () => {
    for (let i = 0; i < 20; i++) {
      cm.add(`entry ${i}`, "test");
    }
    const summary = cm.summarize(3);
    const lines = summary.split("\n");
    expect(lines).toHaveLength(3);
    expect(summary).toContain("entry 19");
    expect(summary).toContain("entry 17");
  });
});
