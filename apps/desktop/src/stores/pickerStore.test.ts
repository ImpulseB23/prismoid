import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowedLive } from "../lib/twitchChannel";

const mocks = vi.hoisted(() => ({
  followedLive: vi.fn<() => Promise<FollowedLive[]>>(),
  preload: vi.fn<(urls: string[]) => Promise<void>>(),
  missing: [] as string[],
}));

vi.mock("../lib/twitchChannel", () => ({
  getFollowedLive: mocks.followedLive,
}));
vi.mock("../lib/preload", () => ({ preloadImages: mocks.preload }));
vi.mock("./authStore", () => ({ missingScopes: () => mocks.missing }));
vi.mock("./userInfoStore", () => ({
  loadUserInfo: () => Promise.resolve(),
  userInfo: (id: string) =>
    id === "a" ? { profile_image_url: "https://img/a.png" } : undefined,
}));

const store = await import("./pickerStore");

const live = (id: string): FollowedLive => ({
  id,
  login: id,
  display_name: id.toUpperCase(),
  game_name: "",
  viewer_count: 1,
});

// The store keeps its list for the module's lifetime, so each test starts
// past the freshness window instead of reloading the module.
describe("picker store", () => {
  let now = Date.now();
  beforeEach(() => {
    now += store.LIVE_FRESH_MS * 2;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    mocks.followedLive.mockReset();
    mocks.preload.mockReset().mockResolvedValue();
    mocks.missing = [];
    store.closePicker();
  });
  afterEach(() => vi.useRealTimers());

  it("hints at a reconnect without the follows scope", async () => {
    mocks.missing = ["user:read:follows"];
    await store.prefetchLive();
    expect(store.liveState()).toBe("needs_scope");
    expect(store.followedLive()).toEqual([]);
    expect(mocks.followedLive).not.toHaveBeenCalled();
  });

  it("marks a failed lookup and clears the list", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.followedLive.mockRejectedValue(new Error("down"));
    await store.prefetchLive();
    expect(store.liveState()).toBe("failed");
    expect(store.followedLive()).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("preloads avatars, shares one request and reuses a fresh list", async () => {
    mocks.followedLive.mockResolvedValue([live("a"), live("b")]);
    await Promise.all([store.prefetchLive(), store.prefetchLive()]);
    expect(mocks.followedLive).toHaveBeenCalledTimes(1);
    expect(mocks.preload).toHaveBeenCalledWith(["https://img/a.png", ""]);
    expect(store.liveState()).toBe("ready");
    expect(store.followedLive().map((c) => c.id)).toEqual(["a", "b"]);
    await store.prefetchLive();
    expect(mocks.followedLive).toHaveBeenCalledTimes(1);
  });

  it("opens after loading and ignores a load the user closed", async () => {
    let resolve!: (v: FollowedLive[]) => void;
    mocks.followedLive.mockReturnValue(new Promise((r) => (resolve = r)));
    store.openPicker();
    expect(store.pickerLoading()).toBe(true);
    store.closePicker();
    resolve([]);
    await vi.waitFor(() => expect(mocks.preload).toHaveBeenCalled());
    await Promise.resolve();
    expect(store.pickerOpen()).toBe(false);
    store.openPicker();
    await vi.waitFor(() => expect(store.pickerOpen()).toBe(true));
    expect(store.pickerLoading()).toBe(false);
    store.openPicker();
    expect(store.pickerLoading()).toBe(false);
  });
});
