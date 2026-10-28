import { describe, expect, it } from "vitest";
import { MAX_MENTIONS, createMentionsStore } from "./mentionsStore";
import type { ChatMessage } from "./chatStore";

const msg = (id: string) => ({ id }) as ChatMessage;

describe("mentionsStore", () => {
  it("keeps mentions newest first without duplicates", () => {
    const s = createMentionsStore();
    s.record(msg("a"));
    s.record(msg("b"));
    s.record(msg("a"));
    expect(s.mentions().map((m) => m.id)).toEqual(["b", "a"]);
    expect(s.unread()).toBe(2);
  });

  it("counts unread only while the panel is closed", () => {
    const s = createMentionsStore();
    s.record(msg("a"));
    s.setOpen(true);
    expect(s.unread()).toBe(0);
    s.record(msg("b"));
    expect(s.unread()).toBe(0);
    s.setOpen(false);
    s.record(msg("c"));
    expect(s.unread()).toBe(1);
    s.clear();
    expect(s.mentions()).toEqual([]);
    expect(s.unread()).toBe(0);
  });

  it("caps the list and forgets the oldest", () => {
    const s = createMentionsStore();
    for (let i = 0; i <= MAX_MENTIONS; i++) s.record(msg(String(i)));
    expect(s.mentions()).toHaveLength(MAX_MENTIONS);
    s.record(msg("0"));
    expect(s.mentions()[0]!.id).toBe("0");
  });
});
