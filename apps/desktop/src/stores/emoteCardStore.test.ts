import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "../lib/pane";
import type { EmoteMeta } from "./chatStore";
import type { SevenTvUser } from "../lib/sevenTvUsers";

const getSevenTvUsers = vi.fn<(ids: string[]) => Promise<SevenTvUser[]>>();
const preloadImages = vi.fn<
  (urls: Iterable<string>, capMs?: number) => Promise<void>
>(() => Promise.resolve());

vi.mock("../lib/sevenTvUsers", () => ({
  getSevenTvUsers: (ids: string[]) => getSevenTvUsers(ids),
}));
vi.mock("../lib/preload", () => ({
  preloadImages: (urls: Iterable<string>, capMs?: number) =>
    preloadImages(urls, capMs),
}));

const {
  HOVER_DELAY_MS,
  closeEmoteCard,
  emoteSetName,
  endEmoteHover,
  hoverEmote,
  hoveredEmote,
  inspectEmote,
  inspectLoading,
  inspectedAddedBy,
  inspectedEmote,
  inspectedPane,
  largeUrl,
  providerLabel,
  providerPage,
} = await import("./emoteCardStore");

const emote = (
  provider: EmoteMeta["provider"],
  id = "abc 1",
  extra: Partial<EmoteMeta> = {},
): EmoteMeta => ({
  id,
  code: "x",
  provider,
  url_1x: "",
  url_2x: "",
  url_4x: "",
  width: 28,
  height: 28,
  animated: false,
  zero_width: false,
  ...extra,
});

const anchor = () => {
  const el = document.createElement("span");
  document.body.append(el);
  return el;
};

describe("emote card", () => {
  afterEach(() => {
    endEmoteHover();
    closeEmoteCard();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("links third-party emotes to their provider page", () => {
    expect(providerPage(emote("7tv"))).toBe("https://7tv.app/emotes/abc%201");
    expect(providerPage(emote("bttv", "b"))).toBe(
      "https://betterttv.com/emotes/b",
    );
    expect(providerPage(emote("ffz", "9"))).toBe(
      "https://www.frankerfacez.com/emoticon/9",
    );
    expect(providerPage(emote("twitch"))).toBeNull();
  });

  it("names providers for people", () => {
    expect(providerLabel("ffz")).toBe("FrankerFaceZ");
    expect(providerLabel("7tv")).toBe("7TV");
  });

  it("names the set an emote comes from", () => {
    expect(emoteSetName(emote("7tv"), "channel", "Forsen")).toBe(
      "Forsen's Emotes",
    );
    expect(emoteSetName(emote("bttv"), "global", "Forsen")).toBe("BTTV Global");
    expect(emoteSetName(emote("7tv"), "channel", undefined)).toBe("7TV");
    expect(emoteSetName(emote("ffz"), undefined, "Forsen")).toBe(
      "FrankerFaceZ",
    );
  });

  it("picks the largest image there is", () => {
    expect(largeUrl(emote("7tv", "a", { url_1x: "1", url_4x: "4" }))).toBe("4");
    expect(largeUrl(emote("7tv", "a", { url_1x: "1", url_2x: "2" }))).toBe("2");
    expect(largeUrl(emote("7tv", "a", { url_1x: "1" }))).toBe("1");
  });
});

describe("emote hover", () => {
  afterEach(() => {
    endEmoteHover();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows after the intent delay with the large images preloaded", async () => {
    vi.useFakeTimers();
    const e = emote("7tv", "a", { url_4x: "big" });
    const o = emote("7tv", "b", { url_2x: "over" });
    hoverEmote(anchor(), e, [o], undefined);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS - 1);
    expect(hoveredEmote()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(hoveredEmote()?.emote).toBe(e);
    expect(hoveredEmote()?.overlays).toEqual([o]);
    expect([...preloadImages.mock.calls[0][0]]).toEqual(["big", "over"]);
  });

  it("stays hidden when the pointer leaves first", async () => {
    vi.useFakeTimers();
    hoverEmote(anchor(), emote("7tv"), [], undefined);
    endEmoteHover();
    await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS);
    expect(hoveredEmote()).toBeNull();
  });

  it("stays hidden when the emote left the page", async () => {
    vi.useFakeTimers();
    const el = anchor();
    hoverEmote(el, emote("7tv"), [], undefined);
    el.remove();
    await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS);
    expect(hoveredEmote()).toBeNull();
  });

  it("hides on end", async () => {
    vi.useFakeTimers();
    hoverEmote(anchor(), emote("7tv"), [], undefined);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY_MS);
    expect(hoveredEmote()).not.toBeNull();
    endEmoteHover();
    expect(hoveredEmote()).toBeNull();
  });
});

describe("emote inspect", () => {
  afterEach(() => {
    closeEmoteCard();
    vi.clearAllMocks();
  });

  it("opens once the adder is known", async () => {
    getSevenTvUsers.mockResolvedValue([
      { id: "other", login: "o", display_name: "Other" },
      { id: "u1", login: "xqc", display_name: "xQc" },
    ]);
    const e = emote("7tv", "a", { added_by_id: "u1" });
    const pane = {} as Pane;
    inspectEmote(e, pane);
    expect(inspectLoading()).toBe("a");
    expect(inspectedEmote()).toBeNull();
    await vi.waitFor(() => expect(inspectedEmote()).toBe(e));
    expect(inspectedPane()).toBe(pane);
    expect(inspectLoading()).toBeNull();
    expect(inspectedAddedBy()?.display_name).toBe("xQc");
    expect(getSevenTvUsers).toHaveBeenCalledWith(["u1"]);
  });

  it("opens without a name when the lookup fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getSevenTvUsers.mockRejectedValue(new Error("down"));
    const e = emote("7tv", "a", { added_by_id: "u1" });
    inspectEmote(e, undefined);
    await vi.waitFor(() => expect(inspectedEmote()).toBe(e));
    expect(inspectedAddedBy()).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("opens without a name when 7tv does not know the adder", async () => {
    getSevenTvUsers.mockResolvedValue([]);
    const e = emote("7tv", "a", { added_by_id: "u1" });
    inspectEmote(e, undefined);
    await vi.waitFor(() => expect(inspectedEmote()).toBe(e));
    expect(inspectedAddedBy()).toBeNull();
  });

  it("skips the lookup without an adder", async () => {
    const e = emote("bttv");
    inspectEmote(e, undefined);
    await vi.waitFor(() => expect(inspectedEmote()).toBe(e));
    expect(getSevenTvUsers).not.toHaveBeenCalled();
  });

  it("does not open after closing while loading", async () => {
    const e = emote("bttv");
    inspectEmote(e, undefined);
    closeEmoteCard();
    expect(inspectLoading()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(inspectedEmote()).toBeNull();
  });
});
