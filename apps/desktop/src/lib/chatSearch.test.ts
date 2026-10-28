import { describe, expect, it } from "vitest";
import { isEmpty, matches, parseQuery } from "./chatSearch";
import type { ChatMessage } from "../stores/chatStore";

const msg = (username: string, text: string, display = username) =>
  ({
    username,
    display_name: display,
    message_text: text,
  }) as ChatMessage;

describe("parseQuery", () => {
  it("splits words and filters", () => {
    expect(parseQuery("  From:@Nymn  has:link  Clip  ")).toEqual({
      words: ["clip"],
      from: "nymn",
      hasLink: true,
    });
    expect(isEmpty(parseQuery("   "))).toBe(true);
    expect(parseQuery("from:").words).toEqual(["from:"]);
  });
});

describe("matches", () => {
  it("needs every word, case insensitive", () => {
    const q = parseQuery("good game");
    expect(matches(msg("a", "GOOD stuff, nice game"), q)).toBe(true);
    expect(matches(msg("a", "good stuff"), q)).toBe(false);
  });

  it("filters by login or display name", () => {
    const q = parseQuery("from:nymn");
    expect(matches(msg("nymn", "hi"), q)).toBe(true);
    expect(matches(msg("x", "hi", "NymN"), q)).toBe(true);
    expect(matches(msg("forsen", "nymn hi"), q)).toBe(false);
  });

  it("finds links", () => {
    const q = parseQuery("has:link");
    expect(matches(msg("a", "look https://clips.twitch.tv/x"), q)).toBe(true);
    expect(matches(msg("a", "www.example.com"), q)).toBe(true);
    expect(matches(msg("a", "no link here"), q)).toBe(false);
  });
});
