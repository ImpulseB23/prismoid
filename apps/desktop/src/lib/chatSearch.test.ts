import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  filterTokens,
  isEmpty,
  matches,
  parseQuery,
  removeToken,
  suggest,
} from "./chatSearch";
import type { ChatMessage } from "../stores/chatStore";

const msg = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: "m",
    username: "viewer",
    display_name: "Viewer",
    message_text: "",
    badges: [],
    emote_spans: [],
    reply_parent: null,
    ...over,
  }) as ChatMessage;

const ctx = {
  isFirst: (id: string) => id === "first",
  isEmote: (w: string) => w === "Kappa7",
};

describe("parseQuery", () => {
  it("splits words and filters, and keeps unknown keys as words", () => {
    expect(
      parseQuery("  From:@Nova mentions:@Kit has:link is:mod Clip  cat:x"),
    ).toEqual({
      words: ["clip", "cat:x"],
      from: "nova",
      mentions: "kit",
      has: ["link"],
      is: ["mod"],
    });
    expect(isEmpty(parseQuery("   "))).toBe(true);
    expect(parseQuery("from:").words).toEqual(["from:"]);
    expect(parseQuery("has:pizza").words).toEqual(["has:pizza"]);
  });
});

describe("matches", () => {
  it("needs every word, case insensitive", () => {
    const q = parseQuery("good game");
    expect(
      matches(msg({ message_text: "GOOD stuff, nice game" }), q, ctx),
    ).toBe(true);
    expect(matches(msg({ message_text: "good stuff" }), q, ctx)).toBe(false);
  });

  it("filters by sender, by name or login", () => {
    const q = parseQuery("from:viewer");
    expect(matches(msg(), q, ctx)).toBe(true);
    expect(
      matches(msg({ username: "other", display_name: "Other" }), q, ctx),
    ).toBe(false);
  });

  it("finds mentions in text or as the replied-to person", () => {
    const q = parseQuery("mentions:kit");
    expect(matches(msg({ message_text: "hey @Kit, nice" }), q, ctx)).toBe(true);
    expect(matches(msg({ message_text: "kitten" }), q, ctx)).toBe(false);
    expect(
      matches(
        msg({
          reply_parent: {
            user_login: "kit",
            user_name: "Kit",
            body: "",
            thread_id: "t",
          },
        }),
        q,
        ctx,
      ),
    ).toBe(true);
  });

  it("checks links and emotes, native or third party", () => {
    expect(
      matches(
        msg({ message_text: "see https://x.io" }),
        parseQuery("has:link"),
        ctx,
      ),
    ).toBe(true);
    const emote = parseQuery("has:emote");
    expect(matches(msg({ message_text: "lol Kappa7" }), emote, ctx)).toBe(true);
    expect(
      matches(
        msg({ emote_spans: [{} as ChatMessage["emote_spans"][number]] }),
        emote,
        ctx,
      ),
    ).toBe(true);
    expect(matches(msg({ message_text: "lol" }), emote, ctx)).toBe(false);
  });

  it("checks first messages, replies and roles from badges", () => {
    expect(matches(msg({ id: "first" }), parseQuery("is:first"), ctx)).toBe(
      true,
    );
    expect(
      matches(msg({ first_message: true }), parseQuery("is:first"), ctx),
    ).toBe(true);
    expect(matches(msg(), parseQuery("is:first"), ctx)).toBe(false);
    expect(matches(msg(), parseQuery("is:reply"), ctx)).toBe(false);
    const sub = msg({ badges: [{ set_id: "founder", id: "0" }] });
    expect(matches(sub, parseQuery("is:sub"), ctx)).toBe(true);
    expect(matches(sub, parseQuery("is:sub is:mod"), ctx)).toBe(false);
    const streamer = msg({ badges: [{ set_id: "broadcaster", id: "1" }] });
    expect(matches(streamer, parseQuery("is:streamer"), ctx)).toBe(true);
  });
});

describe("suggest", () => {
  const names = [
    { login: "nova", display_name: "Nova" },
    { login: "kit_", display_name: "Kit" },
  ];

  it("offers the keys on an empty box or a partial key", () => {
    expect(suggest("", names).map((s) => s.label)).toEqual([
      "from:",
      "mentions:",
      "has:",
      "is:",
    ]);
    expect(suggest("clip m", names).map((s) => s.label)).toEqual(["mentions:"]);
    expect(suggest("clip ", names)).toEqual([]);
  });

  it("offers people and values once a key has its colon", () => {
    expect(suggest("from:k", names).map((s) => s.insert)).toEqual([
      "from:kit_ ",
    ]);
    expect(suggest("is:", names).map((s) => s.label)).toContain("is:vip");
    expect(suggest("has:e", names).map((s) => s.label)).toEqual(["has:emote"]);
  });

  it("swaps in a picked option and removes a filter by its chip", () => {
    const [opt] = suggest("clip fr", names);
    expect(applySuggestion("clip fr", opt)).toBe("clip from:");
    expect(filterTokens("clip from:Nova is:sub")).toEqual([
      { key: "from", value: "nova", raw: "from:Nova" },
      { key: "is", value: "sub", raw: "is:sub" },
    ]);
    expect(removeToken("clip from:Nova is:sub", "from:Nova")).toBe(
      "clip is:sub",
    );
  });
});
