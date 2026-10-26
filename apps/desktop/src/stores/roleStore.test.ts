import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { createRoleStore } from "./roleStore";

const channel = (id: string) => ({
  broadcaster_id: id,
  broadcaster_login: `c${id}`,
  broadcaster_name: `C${id}`,
});

describe("roleStore", () => {
  it("loads the moderated set from the fetcher", async () => {
    const store = createRoleStore(async () => [channel("1"), channel("2")]);
    expect(store.isModeratorOf("1")).toBe(false);
    expect(await store.load()).toBe(true);
    expect(store.isModeratorOf("1")).toBe(true);
    expect(store.isModeratorOf("3")).toBe(false);
  });

  it("keeps the previous set when the lookup fails", async () => {
    let fail = false;
    const store = createRoleStore(async () => {
      if (fail) throw new Error("401");
      return [channel("1")];
    });
    await store.load();
    fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await store.load()).toBe(false);
    spy.mockRestore();
    expect(store.isModeratorOf("1")).toBe(true);
  });

  it("records a role observed live and clears on sign out", async () => {
    const store = createRoleStore(async () => []);
    await store.load();
    store.noteModerator("9");
    expect(store.isModeratorOf("9")).toBe(true);
    store.clear();
    expect(store.isModeratorOf("9")).toBe(false);
  });

  it("ignores a stale load that resolves after clear", async () => {
    let resolve: (
      v: {
        broadcaster_id: string;
        broadcaster_login: string;
        broadcaster_name: string;
      }[],
    ) => void = () => {};
    const store = createRoleStore(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = store.load();
    store.clear();
    resolve([channel("4")]);
    await pending;
    expect(store.isModeratorOf("4")).toBe(false);
  });
});
