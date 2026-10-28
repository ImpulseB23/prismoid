import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createStreamStore } from "./streamStore";
import type { StreamInfo } from "../lib/twitchChannel";

const info = (title: string) => ({ title, is_live: true }) as StreamInfo;

function setup() {
  const pending = new Map<string, (v: StreamInfo | null) => void>();
  const fetch = vi.fn(
    (id: string) =>
      new Promise<StreamInfo | null>((resolve) => pending.set(id, resolve)),
  );
  const [channel, setChannel] = createSignal<string | undefined>("a");
  const store = createStreamStore(fetch, 60_000);
  const dispose = createRoot((d) => {
    store.track(channel);
    return d;
  });
  return { store, pending, setChannel, dispose };
}

describe("streamStore", () => {
  it("loads a new channel, then shows it at once when switching back", async () => {
    const { store, pending, setChannel, dispose } = setup();
    expect(store.loading()).toBe(true);
    pending.get("a")!(info("first"));
    await Promise.resolve();
    expect(store.loading()).toBe(false);
    expect(store.info()?.title).toBe("first");

    setChannel("b");
    expect(store.loading()).toBe(true);
    expect(store.info()).toBeNull();

    setChannel("a");
    expect(store.loading()).toBe(false);
    expect(store.info()?.title).toBe("first");
    dispose();
  });

  it("ignores an answer for a channel no longer shown", async () => {
    const { store, pending, setChannel, dispose } = setup();
    setChannel("b");
    pending.get("a")!(info("late"));
    await Promise.resolve();
    expect(store.info()).toBeNull();
    expect(store.loading()).toBe(true);
    dispose();
  });
});
