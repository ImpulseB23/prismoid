import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type {
  ChannelSearchResult,
  FollowedLive,
  UserInfo,
} from "../lib/twitchChannel";
import type { RecentChannel } from "../stores/channelStore";

const mocks = vi.hoisted(() => ({
  followedLive: vi.fn<() => Promise<FollowedLive[]>>(),
  search: vi.fn<(q: string) => Promise<ChannelSearchResult[]>>(),
  select: vi.fn<(login: string) => Promise<void>>(),
  load: vi.fn<(ids: string[]) => Promise<void>>(),
  missing: [] as string[],
  recents: [] as RecentChannel[],
  profiles: new Map<string, UserInfo>(),
}));

vi.mock("../lib/twitchChannel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/twitchChannel")>()),
  getFollowedLive: mocks.followedLive,
  searchChannels: mocks.search,
}));
vi.mock("../stores/authStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/authStore")>()),
  missingScopes: () => mocks.missing,
}));
vi.mock("../stores/channelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/channelStore")>()),
  recentChannels: () => mocks.recents,
  selectChannel: mocks.select,
}));
vi.mock("../stores/userInfoStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/userInfoStore")>()),
  loadUserInfo: mocks.load,
  userInfo: (id: string) => mocks.profiles.get(id),
}));
vi.mock("../lib/preload", () => ({ preloadImages: () => Promise.resolve() }));

// The picker store keeps the live list between opens, so every test gets
// fresh copies of it and the component.
async function setup(onClose: () => void = () => {}) {
  vi.resetModules();
  const store = await import("../stores/pickerStore");
  const { default: ChannelPicker } = await import("./ChannelPicker");
  render(() => (
    <ChannelPicker
      open={store.pickerOpen()}
      onClose={() => {
        store.closePicker();
        onClose();
      }}
    />
  ));
  return store;
}

const live = (id: string, viewers: number, game = ""): FollowedLive => ({
  id,
  login: id,
  display_name: id.toUpperCase(),
  game_name: game,
  viewer_count: viewers,
});

const recent = (login: string): RecentChannel => ({
  login,
  display_name: login.toUpperCase(),
  profile_image_url: "",
});

const options = () =>
  screen
    .queryAllByRole("option")
    .map(
      (o) => o.querySelector(".palette__item-name")!.firstChild!.textContent,
    );

describe("ChannelPicker", () => {
  beforeEach(() => {
    mocks.followedLive.mockReset();
    mocks.search.mockReset();
    mocks.select.mockReset().mockResolvedValue();
    mocks.load.mockReset().mockResolvedValue();
    mocks.missing = [];
    mocks.recents = [];
    mocks.profiles.clear();
  });
  afterEach(cleanup);

  it("lists live follows above recents without repeating them", async () => {
    mocks.followedLive.mockResolvedValue([
      live("home", 150, "Chess"),
      live("big", 50_000),
    ]);
    mocks.recents = [recent("home"), recent("old")];
    mocks.profiles.set("home", {
      id: "home",
      login: "home",
      display_name: "HOME",
      profile_image_url: "https://img/home.png",
      description: "",
      created_at: "",
    });
    (await setup()).openPicker();
    await screen.findByText("BIG");
    expect(options()).toEqual(["HOME", "BIG", "OLD"]);
    expect(mocks.load).toHaveBeenCalledWith(["home", "big"]);
    const [home, big] = screen.getAllByRole("option");
    expect(home!.textContent).toContain("150 watching · Chess");
    expect(home!.querySelector(".palette__live")).not.toBeNull();
    expect(home!.querySelector("img")!.getAttribute("src")).toBe(
      "https://img/home.png",
    );
    expect(big!.querySelector("img")).toBeNull();
  });

  it("opens only once the live list has loaded", async () => {
    let resolve!: (v: FollowedLive[]) => void;
    mocks.followedLive.mockReturnValue(new Promise((r) => (resolve = r)));
    mocks.recents = [recent("old")];
    const onClose = vi.fn();
    const store = await setup(onClose);
    store.openPicker();
    expect(store.pickerLoading()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    resolve([live("a", 10)]);
    await screen.findByText("A");
    expect(store.pickerLoading()).toBe(false);
    expect(options()).toEqual(["A", "OLD"]);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = screen
      .getAllByRole("option")
      .map((o) => o.getAttribute("aria-selected"));
    expect(selected).toEqual(["false", "true"]);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.select).toHaveBeenCalledWith("old");
  });

  it("opens a live channel on click", async () => {
    mocks.followedLive.mockResolvedValue([live("a", 10)]);
    const onClose = vi.fn();
    (await setup(onClose)).openPicker();
    fireEvent.click(await screen.findByText("A"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.select).toHaveBeenCalledWith("a");
  });

  it("says so when nobody followed is live", async () => {
    mocks.followedLive.mockResolvedValue([]);
    (await setup()).openPicker();
    await screen.findByText("Nobody you follow is live right now.");
    expect(screen.queryByText("Channels you open will show up here.")).toBe(
      null,
    );
  });

  it("asks for a reconnect without the follows scope", async () => {
    mocks.missing = ["user:read:follows"];
    (await setup()).openPicker();
    await screen.findByText(
      "Reconnect Twitch in Settings to see who you follow that's live.",
    );
    expect(mocks.followedLive).not.toHaveBeenCalled();
  });

  it("still opens, without the section, when the lookup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.followedLive.mockRejectedValue({ kind: "http", message: "down" });
    (await setup()).openPicker();
    await screen.findByText("Channels you open will show up here.");
    expect(error).toHaveBeenCalled();
    expect(screen.queryByText("Live now")).toBeNull();
    error.mockRestore();
  });

  it("hides the live list once a search is typed", async () => {
    mocks.followedLive.mockResolvedValue([live("a", 10)]);
    mocks.search.mockResolvedValue([
      {
        id: "9",
        login: "found",
        display_name: "FOUND",
        profile_image_url: "",
        is_live: false,
        game_name: "",
        title: "",
        viewer_count: null,
        followers: 12,
        followed: false,
      },
    ]);
    (await setup()).openPicker();
    await screen.findByText("A");
    fireEvent.input(screen.getByRole("textbox"), {
      target: { value: "fou" },
    });
    expect(screen.queryByText("Live now")).toBeNull();
    await screen.findByText("FOUND");
    expect(options()).toEqual(["FOUND"]);
    expect(mocks.search).toHaveBeenCalledWith("fou");
  });

  it("reuses a fresh list on a quick reopen", async () => {
    mocks.followedLive.mockResolvedValue([live("a", 10)]);
    const store = await setup();
    store.openPicker();
    await screen.findByText("A");
    store.closePicker();
    store.openPicker();
    await screen.findByText("A");
    expect(mocks.followedLive).toHaveBeenCalledTimes(1);
  });
});
