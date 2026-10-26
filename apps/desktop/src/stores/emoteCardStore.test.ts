import { describe, expect, it } from "vitest";
import { providerLabel, providerPage } from "./emoteCardStore";
import type { EmoteMeta } from "./chatStore";

const emote = (provider: EmoteMeta["provider"], id = "abc 1"): EmoteMeta => ({
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
});

describe("emote card", () => {
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
});
