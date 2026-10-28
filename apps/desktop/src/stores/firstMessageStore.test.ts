import { describe, expect, it } from "vitest";
import { createMemo, createRoot } from "solid-js";
import { createFirstMessageStore } from "./firstMessageStore";

describe("firstMessageStore", () => {
  it("re-runs a lookup made before the mark lands", () => {
    const store = createFirstMessageStore();
    createRoot((dispose) => {
      let runs = 0;
      const first = createMemo(() => {
        runs++;
        return store.isFirst("m1");
      });
      expect(first()).toBe(false);
      store.mark("m1");
      expect(first()).toBe(true);
      store.mark("m1");
      expect(runs).toBe(2);
      dispose();
    });
  });

  it("drops the oldest ids past the cap", () => {
    const store = createFirstMessageStore(2);
    store.mark("a");
    store.mark("b");
    store.mark("c");
    expect(store.isFirst("a")).toBe(false);
    expect(store.isFirst("b")).toBe(true);
    expect(store.isFirst("c")).toBe(true);
  });
});
