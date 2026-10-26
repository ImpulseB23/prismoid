import { describe, expect, it } from "vitest";
import { createChatterStore } from "./chatterStore";

describe("chatterStore", () => {
  it("orders by most recent speaker and dedupes", () => {
    const s = createChatterStore();
    s.record("1", "a", "A", 10);
    s.record("2", "b", "B", 20);
    s.record("1", "a", "A2", 30);
    expect(s.recent()).toEqual([
      { id: "1", login: "a", display_name: "A2" },
      { id: "2", login: "b", display_name: "B" },
    ]);
    expect(s.byLogin("b")?.id).toBe("2");
  });

  it("counts messages per person from their first appearance", () => {
    const s = createChatterStore();
    s.record("1", "a", "A", 10);
    s.record("1", "a", "A", 25);
    expect(s.stats("1")).toEqual({ messages: 2, firstSeen: 10 });
    expect(s.stats("9")).toBeUndefined();
    s.clear();
    expect(s.stats("1")).toBeUndefined();
  });

  it("evicts the least recent past the cap", () => {
    const s = createChatterStore(2);
    s.record("1", "a", "A", 1);
    s.record("2", "b", "B", 2);
    s.record("3", "c", "C", 3);
    expect(s.recent().map((c) => c.login)).toEqual(["c", "b"]);
    expect(s.stats("1")).toBeUndefined();
  });
});
