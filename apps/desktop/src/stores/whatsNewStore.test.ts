import { describe, expect, it, vi } from "vitest";
import { createWhatsNewStore, releaseNotesUrl } from "./whatsNewStore";
import type { StorageLike } from "./channelStore";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

function memStorage(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("whatsNewStore", () => {
  it("stays quiet on a first install and remembers the version", async () => {
    const storage = memStorage();
    const store = createWhatsNewStore(storage, async () => "0.4.0");
    await store.init();
    expect(store.updatedTo()).toBeNull();
    expect(store.unseen()).toBe(false);
    expect(storage.getItem("prismoid.lastVersion")).toBe("0.4.0");
  });

  it("announces an update until Settings is opened", async () => {
    const storage = memStorage({ "prismoid.lastVersion": "0.3.1" });
    const store = createWhatsNewStore(
      storage,
      async () => "0.4.0",
      () => undefined,
    );
    await store.init();
    expect(store.updatedTo()).toBe("0.4.0");
    expect(store.unseen()).toBe(true);
    store.markSeen();
    expect(store.unseen()).toBe(false);
    expect(store.updatedTo()).toBe("0.4.0");
  });

  it("opens the patch notes when the new version has them", async () => {
    const note = { version: "0.6.0", headline: "h", features: [], fixes: [] };
    const store = createWhatsNewStore(
      memStorage({ "prismoid.lastVersion": "0.5.0" }),
      async () => "0.6.0",
      (v) => (v === "0.6.0" ? note : undefined),
    );
    await store.init();
    expect(store.notes()).toBe(note);
    expect(store.unseen()).toBe(false);
    store.closeNotes();
    expect(store.notes()).toBeNull();
    store.showNotes(note);
    expect(store.notes()).toBe(note);
  });

  it("says nothing on a normal relaunch", async () => {
    const storage = memStorage({ "prismoid.lastVersion": "0.4.0" });
    const store = createWhatsNewStore(storage, async () => "0.4.0");
    await store.init();
    expect(store.updatedTo()).toBeNull();
  });

  it("works without storage", async () => {
    const store = createWhatsNewStore(null, async () => "0.4.0");
    await store.init();
    expect(store.updatedTo()).toBeNull();
  });

  it("links to the release page", () => {
    expect(releaseNotesUrl("0.4.0")).toBe(
      "https://github.com/ImpulseB23/Prismoid/releases/tag/v0.4.0",
    );
  });
});
