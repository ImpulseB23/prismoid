import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  canModerateIn,
  clearRoles,
  holdsModRole,
  createRoleStore,
  noteModerator,
  reconnectScopes,
} from "./roleStore";
import { setAuthStatus } from "./authStore";
import { updateSettings } from "./settingsStore";

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

  it("asks for the warn scope only from people who moderate a channel", () => {
    setAuthStatus({
      state: "logged_in",
      login: "me",
      user_id: "1",
      missing_scopes: ["moderator:manage:warnings", "user:read:follows"],
      enabled_scope_groups: [],
    });
    expect(reconnectScopes()).toEqual(["user:read:follows"]);
    noteModerator("9");
    expect(reconnectScopes()).toEqual([
      "moderator:manage:warnings",
      "user:read:follows",
    ]);
    clearRoles();
    setAuthStatus(null);
  });

  it("checks moderation in the channel asked about, not the one on screen", () => {
    setAuthStatus({
      state: "logged_in",
      login: "me",
      user_id: "1",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    expect(canModerateIn("1")).toBe(true);
    expect(canModerateIn("7")).toBe(false);
    noteModerator("7");
    expect(canModerateIn("7")).toBe(true);
    clearRoles();
    setAuthStatus(null);
    expect(canModerateIn("1")).toBe(false);
  });

  it("hides the tools but keeps the role while mod tools are off", async () => {
    setAuthStatus({
      state: "logged_in",
      login: "me",
      user_id: "1",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    noteModerator("7");
    await updateSettings({ modTools: false });
    expect(canModerateIn("7")).toBe(false);
    expect(holdsModRole("7")).toBe(true);
    expect(holdsModRole("1")).toBe(true);
    await updateSettings({ modTools: true });
    expect(canModerateIn("7")).toBe(true);
    clearRoles();
    setAuthStatus(null);
    expect(holdsModRole("1")).toBe(false);
  });

  it("records a role observed live and clears on sign out", async () => {
    const store = createRoleStore(async () => []);
    await store.load();
    expect(store.moderatesAny()).toBe(false);
    store.noteModerator("9");
    expect(store.moderatesAny()).toBe(true);
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
