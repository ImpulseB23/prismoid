import { describe, expect, it } from "vitest";
import { findLinks, hrefFor, linkify } from "./links";

describe("findLinks", () => {
  it("finds http and www links and drops trailing punctuation", () => {
    const text = "see https://twitch.tv/xqc, and www.example.com/a?b=1).";
    const links = findLinks(text).map((l) => text.slice(l.start, l.end));
    expect(links).toEqual(["https://twitch.tv/xqc", "www.example.com/a?b=1"]);
  });

  it("ignores bare domains", () => {
    expect(findLinks("lol.ok whatever twitch.tv/xqc")).toEqual([]);
  });
});

describe("hrefFor", () => {
  it("adds a scheme to www links only", () => {
    expect(hrefFor("www.a.com")).toBe("https://www.a.com");
    expect(hrefFor("http://a.com")).toBe("http://a.com");
  });
});

describe("linkify", () => {
  it("splits text pieces around links and leaves emotes alone", () => {
    const emote = {
      kind: "emote" as const,
      primary: {
        emote: {
          id: "1",
          code: "Kappa",
          provider: "twitch" as const,
          url_1x: "",
          url_2x: "",
          url_4x: "",
          width: 28,
          height: 28,
          animated: false,
          zero_width: false,
        },
        width: 28,
        height: 28,
      },
      overlays: [],
    };
    const out = linkify([
      { kind: "text", text: "go https://a.com now" },
      emote,
    ]);
    expect(out).toEqual([
      { kind: "text", text: "go " },
      { kind: "link", text: "https://a.com", href: "https://a.com" },
      { kind: "text", text: " now" },
      emote,
    ]);
  });
});
