import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  RATE_WINDOW_MS,
  createPulseStore,
} from "./pulseStore";

function setup() {
  let t = 1_000_000;
  const store = createPulseStore(() => t);
  return { store, advance: (ms: number) => (t += ms), at: () => t };
}

describe("pulse", () => {
  it("counts the last minute exactly and lets old messages age out", () => {
    const { store, advance, at } = setup();
    store.record("c", "a", at());
    advance(30_000);
    store.record("c", "b", at());
    store.record("c", "a", at());
    expect(store.perMinute("c")).toBe(3);
    advance(RATE_WINDOW_MS - 30_000);
    expect(store.perMinute("c")).toBe(2);
    advance(30_000);
    expect(store.perMinute("c")).toBe(0);
  });

  it("counts each chatter once over five minutes", () => {
    const { store, advance, at } = setup();
    store.record("c", "a", at());
    store.record("c", "a", at());
    store.record("c", "b", at());
    expect(store.activeChatters("c")).toBe(2);
    advance(ACTIVE_WINDOW_MS - 1000);
    store.record("c", "a", at());
    advance(1000);
    expect(store.activeChatters("c")).toBe(1);
  });

  it("keeps every channel apart, including ones not on screen", () => {
    const { store, at } = setup();
    store.record("one", "a", at());
    store.record("two", "a", at());
    store.record("two", "b", at());
    expect(store.perMinute("one")).toBe(1);
    expect(store.perMinute("two")).toBe(2);
    expect(store.activeChatters("two")).toBe(2);
    expect(store.perMinute("unknown")).toBe(0);
  });

  it("forgets closed channels", () => {
    const { store, at } = setup();
    store.record("one", "a", at());
    store.record("two", "a", at());
    store.retain(["two"]);
    expect(store.perMinute("one")).toBe(0);
    expect(store.perMinute("two")).toBe(1);
  });

  it("stays correct across compaction", () => {
    const { store, advance, at } = setup();
    for (let i = 0; i < 3000; i++) store.record("c", `u${i % 50}`, at());
    advance(RATE_WINDOW_MS);
    store.record("c", "late", at());
    expect(store.perMinute("c")).toBe(1);
    expect(store.activeChatters("c")).toBe(51);
  });
});
