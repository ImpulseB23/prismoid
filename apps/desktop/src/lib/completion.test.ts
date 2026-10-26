import { describe, expect, it } from "vitest";
import type { EmoteMeta } from "../stores/chatStore";
import {
  MAX_CANDIDATES,
  applyCompletion,
  complete,
  wordAtCaret,
} from "./completion";

function emote(code: string): EmoteMeta {
  return {
    id: code,
    code,
    provider: "7tv",
    url_1x: "",
    url_2x: "",
    url_4x: "",
    width: 28,
    height: 28,
    animated: false,
    zero_width: false,
  };
}

const emotes = [
  "Kappa",
  "KappaPride",
  "PogChamp",
  "peepoHappy",
  "OMEGALUL",
].map(emote);
const chatters = [
  { id: "1", login: "forsen", display_name: "forsen" },
  { id: "2", login: "xqc", display_name: "xQc" },
  { id: "3", login: "nymn", display_name: "NymN" },
];

describe("wordAtCaret", () => {
  it("finds the token around the caret", () => {
    expect(wordAtCaret("hello Kap world", 9)).toEqual({
      start: 6,
      end: 9,
      word: "Kap",
    });
    expect(wordAtCaret("hello Kappa world", 8)).toEqual({
      start: 6,
      end: 11,
      word: "Ka",
    });
  });

  it("returns an empty word on whitespace", () => {
    expect(wordAtCaret("hi ", 3)).toEqual({ start: 3, end: 3, word: "" });
  });
});

describe("complete", () => {
  it("ranks prefix matches before substring matches", () => {
    const got = complete("kappa", emotes, chatters).map((c) => c.insert);
    expect(got).toEqual(["Kappa", "KappaPride"]);
    expect(complete("pride", emotes, chatters)[0]?.insert).toBe("KappaPride");
  });

  it("is case insensitive and mixes users into bare words", () => {
    const got = complete("ny", emotes, chatters);
    expect(got).toEqual([
      {
        kind: "user",
        chatter: { id: "3", login: "nymn", display_name: "NymN" },
        insert: "@NymN",
      },
    ]);
  });

  it("scopes @ to chatters and : to emotes", () => {
    expect(complete("@", emotes, chatters).map((c) => c.insert)).toEqual([
      "@forsen",
      "@xQc",
      "@NymN",
    ]);
    expect(complete(":p", emotes, chatters).map((c) => c.insert)).toEqual([
      "PogChamp",
      "peepoHappy",
      "Kappa",
      "KappaPride",
    ]);
    expect(complete(":", emotes, chatters)).toEqual([]);
  });

  it("needs two characters for bare words and caps the list", () => {
    expect(complete("k", emotes, chatters)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => emote(`emote${i}`));
    expect(complete("emote", many, [])).toHaveLength(MAX_CANDIDATES);
  });
});

describe("applyCompletion", () => {
  it("replaces the token and places the caret after a space", () => {
    const at = wordAtCaret("hello Kap world", 9);
    expect(applyCompletion("hello Kap world", at, "Kappa")).toEqual({
      text: "hello Kappa world",
      caret: 12,
    });
  });

  it("does not double a space at the end", () => {
    const at = wordAtCaret("Kap", 3);
    expect(applyCompletion("Kap", at, "Kappa")).toEqual({
      text: "Kappa ",
      caret: 6,
    });
  });
});
