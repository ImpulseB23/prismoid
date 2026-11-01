import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RaidEvent } from "../lib/chatEvents";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { createOfflineStore, LIVE_POLL_MS } = await import("./offlineStore");

function setup(opts: { tabs?: string[]; own?: string | null } = {}) {
  let live: string[] = [];
  const tabs = opts.tabs ?? ["a", "b"];
  let minutes = 5;
  const closed: string[] = [];
  const store = createOfflineStore({
    live: async (ids) => live.filter((id) => ids.includes(id)),
    tabs: () => tabs,
    own: () => opts.own ?? null,
    minutes: () => minutes,
    close: async (id) => {
      closed.push(id);
    },
    now: Date.now,
  });
  return {
    store,
    closed,
    setLive: (ids: string[]) => (live = ids),
    setMinutes: (m: number) => (minutes = m),
  };
}

const raid = (from: string): RaidEvent => ({
  kind: "raid",
  channel_id: from,
  to_user_id: "9",
  to_user_login: "friend",
  to_user_name: "Friend",
  viewers: 120,
});

describe("offlineStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down a chat once its stream ends, then closes it", async () => {
    const { store, closed, setLive } = setup();
    setLive(["a", "b"]);
    await store.poll();
    expect(store.secondsLeft("a")).toBeNull();

    setLive(["b"]);
    await store.poll();
    expect(store.secondsLeft("a")).toBe(300);
    expect(store.secondsLeft("b")).toBeNull();

    await vi.advanceTimersByTimeAsync(299_000);
    expect(store.secondsLeft("a")).toBe(1);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toEqual(["a"]);
    expect(store.secondsLeft("a")).toBeNull();
  });

  it("leaves channels that were never seen live and the user's own", async () => {
    const { store, closed, setLive } = setup({ tabs: ["a", "me"], own: "me" });
    setLive(["me"]);
    await store.poll();
    setLive([]);
    await store.poll();
    expect(store.secondsLeft("a")).toBeNull();
    expect(store.secondsLeft("me")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(closed).toEqual([]);
  });

  it("stops counting when kept open or when the stream comes back", async () => {
    const { store, closed, setLive } = setup();
    setLive(["a", "b"]);
    await store.poll();
    setLive([]);
    await store.poll();
    store.keepOpen("a");
    expect(store.secondsLeft("a")).toBeNull();

    setLive(["b"]);
    await store.poll();
    expect(store.secondsLeft("b")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(closed).toEqual([]);
  });

  it("starts the countdown over while the user is writing", async () => {
    const { store, closed, setLive } = setup();
    setLive(["a"]);
    await store.poll();
    setLive([]);
    await store.poll();
    await vi.advanceTimersByTimeAsync(240_000);
    store.noteActivity("a");
    expect(store.secondsLeft("a")).toBe(300);
    store.noteActivity("b");
    expect(store.secondsLeft("b")).toBeNull();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(closed).toEqual([]);
  });

  it("offers the raid of an ended stream until the stream returns", async () => {
    const { store, setLive } = setup();
    store.noteRaid(raid("elsewhere"));
    expect(store.raidOf("elsewhere")).toBeNull();
    store.noteRaid(raid("a"));
    expect(store.raidOf("a")).toEqual({ login: "friend", name: "Friend" });
    setLive(["a"]);
    await store.poll();
    expect(store.raidOf("a")).toBeNull();
  });

  it("never closes anything when switched off, even mid countdown", async () => {
    const { store, closed, setLive, setMinutes } = setup();
    setLive(["a", "b"]);
    await store.poll();
    setLive(["b"]);
    await store.poll();
    setMinutes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.secondsLeft("a")).toBeNull();
    setLive([]);
    await store.poll();
    expect(store.secondsLeft("b")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(closed).toEqual([]);
  });

  it("checks right away and then every minute until stopped", async () => {
    const live = vi.fn(async () => [] as string[]);
    const store = createOfflineStore({
      live,
      tabs: () => ["a"],
      own: () => null,
      minutes: () => 5,
      close: async () => {},
      now: Date.now,
    });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(live).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(live).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("forgets tabs that were closed in the meantime", async () => {
    let tabs = ["a"];
    let live: string[] = ["a"];
    const store = createOfflineStore({
      live: async () => live,
      tabs: () => tabs,
      own: () => null,
      minutes: () => 5,
      close: async () => {},
      now: Date.now,
    });
    await store.poll();
    live = [];
    await store.poll();
    expect(store.secondsLeft("a")).toBe(300);
    tabs = [];
    await store.poll();
    expect(store.secondsLeft("a")).toBeNull();
  });
});
