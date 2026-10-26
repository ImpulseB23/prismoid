import { describe, expect, it } from "vitest";
import {
  formatChannelError,
  isForChannel,
  normalizeLogin,
} from "./twitchChannel";

describe("isForChannel", () => {
  it("filters twitch messages by broadcaster id", () => {
    expect(isForChannel({ platform: "Twitch", channel_id: "1" }, "1")).toBe(
      true,
    );
    expect(isForChannel({ platform: "Twitch", channel_id: "2" }, "1")).toBe(
      false,
    );
  });

  it("passes other platforms and unknown active channel through", () => {
    expect(isForChannel({ platform: "YouTube", channel_id: "x" }, "1")).toBe(
      true,
    );
    expect(
      isForChannel({ platform: "Twitch", channel_id: "2" }, undefined),
    ).toBe(true);
  });
});

describe("normalizeLogin", () => {
  it("lowercases, trims and strips a leading @", () => {
    expect(normalizeLogin(" @XQC ")).toBe("xqc");
    expect(normalizeLogin("some_user_1")).toBe("some_user_1");
  });

  it("accepts pasted channel links", () => {
    expect(normalizeLogin("https://www.twitch.tv/xQc")).toBe("xqc");
    expect(normalizeLogin("twitch.tv/xqc/videos?x=1")).toBe("xqc");
    expect(normalizeLogin("https://m.twitch.tv/xqc")).toBe("xqc");
  });

  it("rejects other urls, spaces, empties and long handles", () => {
    expect(normalizeLogin("")).toBeNull();
    expect(normalizeLogin("@")).toBeNull();
    expect(normalizeLogin("youtube.com/xqc")).toBeNull();
    expect(normalizeLogin("has space")).toBeNull();
    expect(normalizeLogin("a".repeat(26))).toBeNull();
  });
});

describe("formatChannelError", () => {
  it("names the missing channel", () => {
    expect(
      formatChannelError({ kind: "not_found", login: "nobody" }),
    ).toContain('"nobody"');
  });

  it("distinguishes 401 from other helix statuses", () => {
    expect(
      formatChannelError({ kind: "helix", status: 401, message: "" }),
    ).toMatch(/sign out/i);
    expect(
      formatChannelError({ kind: "helix", status: 503, message: "" }),
    ).toContain("503");
  });

  it("falls back to Error messages and strings", () => {
    expect(formatChannelError(new Error("boom"))).toBe("boom");
    expect(formatChannelError("raw")).toBe("raw");
  });
});
