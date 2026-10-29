import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { EmoteMeta } from "../stores/chatStore";

const [animated, setAnimated] = createSignal(true);
vi.mock("../stores/settingsStore", () => ({
  settings: () => ({ animatedEmotes: animated() }),
}));

const { emoteImages } = await import("./emoteImage");

const emote = (extra: Partial<EmoteMeta>) =>
  ({ url_1x: "a1", url_2x: "a2", ...extra }) as EmoteMeta;

describe("emoteImages", () => {
  it("shows still frames only while animation is off", () => {
    const anim = emote({ static_1x: "s1", static_2x: "s2" });
    expect(emoteImages(anim)).toEqual({ x1: "a1", x2: "a2" });
    setAnimated(false);
    expect(emoteImages(anim)).toEqual({ x1: "s1", x2: "s2" });
    expect(emoteImages(emote({}))).toEqual({ x1: "a1", x2: "a2" });
    expect(emoteImages(emote({ static_1x: "s1" }))).toEqual({
      x1: "s1",
      x2: "",
    });
  });
});
