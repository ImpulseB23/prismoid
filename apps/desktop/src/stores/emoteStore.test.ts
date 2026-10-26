import { describe, expect, it } from "vitest";
import type { EmoteMeta } from "./chatStore";
import { createEmoteStore } from "./emoteStore";

function emote(code: string, provider: EmoteMeta["provider"]): EmoteMeta {
  return {
    id: `${provider}-${code}`,
    code,
    provider,
    url_1x: "",
    url_2x: "",
    url_4x: "",
    width: 28,
    height: 28,
    animated: false,
    zero_width: false,
  };
}

describe("emoteStore", () => {
  it("lets channel sets override global codes and sorts", () => {
    const s = createEmoteStore();
    s.loadBundle({
      twitch_global_emotes: { emotes: [emote("Kappa", "twitch")] },
      seventv_global: { emotes: [emote("peepoHappy", "7tv")] },
      seventv_channel: { emotes: [emote("Kappa", "7tv")] },
    });
    expect(s.all().map((e) => e.code)).toEqual(["Kappa", "peepoHappy"]);
    expect(s.byCode("Kappa")?.provider).toBe("7tv");
    expect(s.revision()).toBe(1);
  });
});
