import { describe, expect, it } from "vitest";
import { chipLabel, isOn, patchFor } from "./chatModes";
import type { ChatSettings } from "./twitchChannel";

const off: ChatSettings = {
  emote_mode: false,
  follower_mode: false,
  follower_mode_duration: null,
  slow_mode: false,
  slow_mode_wait_time: null,
  subscriber_mode: false,
  unique_chat_mode: false,
  non_moderator_chat_delay: false,
  non_moderator_chat_delay_duration: null,
};

describe("chatModes", () => {
  it("turns timed modes on with the dashboard defaults", () => {
    expect(patchFor("slow", true)).toEqual({
      slow_mode: true,
      slow_mode_wait_time: 30,
    });
    expect(patchFor("followers", true)).toEqual({
      follower_mode: true,
      follower_mode_duration: 0,
    });
    expect(patchFor("delay", true)).toEqual({
      non_moderator_chat_delay: true,
      non_moderator_chat_delay_duration: 2,
    });
    expect(patchFor("slow", false)).toEqual({ slow_mode: false });
    expect(patchFor("emote", true)).toEqual({ emote_mode: true });
    expect(patchFor("subscriber", false)).toEqual({ subscriber_mode: false });
    expect(patchFor("unique", true)).toEqual({ unique_chat_mode: true });
  });

  it("reads each mode", () => {
    const on: ChatSettings = {
      ...off,
      emote_mode: true,
      subscriber_mode: true,
      unique_chat_mode: true,
      slow_mode: true,
      follower_mode: true,
      non_moderator_chat_delay: true,
    };
    for (const m of [
      "emote",
      "subscriber",
      "unique",
      "slow",
      "followers",
      "delay",
    ] as const) {
      expect(isOn(on, m)).toBe(true);
      expect(isOn(off, m)).toBe(false);
    }
  });

  it("labels active modes with their duration", () => {
    expect(chipLabel(null, "slow")).toBe("Slow");
    expect(
      chipLabel({ ...off, slow_mode: true, slow_mode_wait_time: 10 }, "slow"),
    ).toBe("Slow 10s");
    const followers = (min: number) =>
      chipLabel(
        { ...off, follower_mode: true, follower_mode_duration: min },
        "followers",
      );
    expect(followers(0)).toBe("Followers");
    expect(followers(10)).toBe("Followers 10m");
    expect(followers(60)).toBe("Followers 1h");
    expect(followers(1440)).toBe("Followers 1d");
    expect(followers(10_080)).toBe("Followers 1w");
    expect(followers(43_200)).toBe("Followers 1mo");
    expect(
      chipLabel(
        {
          ...off,
          non_moderator_chat_delay: true,
          non_moderator_chat_delay_duration: 4,
        },
        "delay",
      ),
    ).toBe("Delay 4s");
    expect(chipLabel(off, "subscriber")).toBe("Subs");
    expect(chipLabel(off, "emote")).toBe("Emotes");
    expect(chipLabel(off, "unique")).toBe("Unique");
  });
});
