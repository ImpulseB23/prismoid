import { describe, expect, it } from "vitest";
import { createChatterStore } from "./chatterStore";

describe("chatterStore", () => {
  it("orders by most recent speaker and dedupes", () => {
    const s = createChatterStore();
    s.record("1", "a", "A", null, 10);
    s.record("2", "b", "B", null, 20);
    s.record("1", "a", "A2", null, 30);
    expect(s.recent()).toEqual([
      { id: "1", login: "a", display_name: "A2", color: null },
      { id: "2", login: "b", display_name: "B", color: null },
    ]);
    expect(s.byLogin("b")?.id).toBe("2");
  });

  it("counts messages per person from their first appearance", () => {
    const s = createChatterStore();
    s.record("1", "a", "A", null, 10);
    s.record("1", "a", "A", null, 25);
    expect(s.stats("1")).toEqual({ messages: 2, firstSeen: 10 });
    expect(s.stats("9")).toBeUndefined();
    s.clear();
    expect(s.stats("1")).toBeUndefined();
  });

  it("evicts the least recent past the cap", () => {
    const s = createChatterStore(2);
    s.record("1", "a", "A", null, 1);
    s.record("2", "b", "B", null, 2);
    s.record("3", "c", "C", null, 3);
    expect(s.recent().map((c) => c.login)).toEqual(["c", "b"]);
    expect(s.stats("1")).toBeUndefined();
  });

  it("ranks people from history below anyone heard live", () => {
    const s = createChatterStore();
    s.record("1", "live", "Live", null, 10);
    s.recordPast([
      { id: "2", login: "old", display_name: "Old", color: null },
      { id: "1", login: "live", display_name: "Live", color: null },
      { id: "3", login: "older", display_name: "Older", color: null },
      { id: "2", login: "old", display_name: "Old", color: null },
    ]);
    expect(s.recent().map((c) => c.login)).toEqual(["live", "old", "older"]);
    expect(s.byLogin("older")?.id).toBe("3");
  });

  it("keeps the newest when history overflows the cap", () => {
    const s = createChatterStore(2);
    s.record("1", "live", "Live", null, 10);
    s.recordPast([
      { id: "2", login: "a", display_name: "A", color: null },
      { id: "3", login: "b", display_name: "B", color: null },
    ]);
    expect(s.recent().map((c) => c.login)).toEqual(["live", "b"]);
  });
});
