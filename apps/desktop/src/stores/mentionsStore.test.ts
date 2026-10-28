import { describe, expect, it, vi } from "vitest";
import {
  MAX_MENTIONS,
  createMentionsStore,
  isMentionFor,
} from "./mentionsStore";
import type { ChatMessage } from "./chatStore";
import type { StorageLike } from "./channelStore";

const msg = (id: string, timestamp: number, over: Partial<ChatMessage> = {}) =>
  ({
    id,
    timestamp,
    username: "viewer",
    message_text: "hi @me",
    notice: null,
    ...over,
  }) as ChatMessage;

function memStorage(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const store = (
  storage = memStorage(),
  load: (id: string) => Promise<ChatMessage[]> = async () => [],
  clock = { t: 1_000 },
) => createMentionsStore(storage, load, () => clock.t);

describe("isMentionFor", () => {
  it("skips your own messages, notices and ignored people", () => {
    expect(isMentionFor(msg("a", 0), "me", [], [])).toBe(true);
    expect(isMentionFor(msg("a", 0, { username: "me" }), "me", [], [])).toBe(
      false,
    );
    expect(isMentionFor(msg("a", 0), "me", [], ["viewer"])).toBe(false);
    expect(
      isMentionFor(
        msg("a", 0, { notice: { notice_type: "sub", system_message: "" } }),
        "me",
        [],
        [],
      ),
    ).toBe(false);
  });
});

describe("mentionsStore", () => {
  it("keeps mentions newest first without duplicates", () => {
    const s = store();
    s.record(msg("b", 20));
    s.record(msg("a", 10));
    s.record(msg("b", 20));
    expect(s.mentions().map((m) => m.id)).toEqual(["b", "a"]);
    expect(s.unread()).toBe(2);
  });

  it("counts what is newer than the last look, and remembers that look", () => {
    const clock = { t: 1_000 };
    const storage = memStorage();
    const s = store(storage, undefined, clock);
    s.record(msg("a", 500));
    s.setOpen(true);
    expect(s.unread()).toBe(0);
    clock.t = 2_000;
    s.record(msg("b", 1_500));
    expect(s.unread()).toBe(0);
    s.setOpen(false);
    s.record(msg("c", 2_500));
    expect(s.unread()).toBe(1);

    const later = store(storage, undefined, clock);
    later.record(msg("a", 500));
    later.record(msg("c", 2_500));
    expect(later.unread()).toBe(1);
  });

  it("finds mentions in each channel's history once", async () => {
    const load = vi.fn(async (id: string) => [
      msg(`${id}-1`, 100),
      msg(`${id}-2`, 200, { message_text: "nothing here" }),
    ]);
    const s = store(memStorage(), load);
    const mine = (m: ChatMessage) => isMentionFor(m, "me", [], []);
    await s.scanHistory("1", mine);
    await s.scanHistory("1", mine);
    await s.scanHistory("2", mine);
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      s
        .mentions()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["1-1", "2-1"]);
  });

  it("retries a channel whose history failed to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi
      .fn<(id: string) => Promise<ChatMessage[]>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce([msg("x", 1)]);
    const s = store(memStorage(), load);
    await s.scanHistory("1", () => true);
    await s.scanHistory("1", () => true);
    expect(s.mentions()).toHaveLength(1);
  });

  it("caps the list and forgets the oldest", () => {
    const s = store();
    for (let i = 0; i <= MAX_MENTIONS; i++) s.record(msg(String(i), i));
    expect(s.mentions()).toHaveLength(MAX_MENTIONS);
    s.record(msg("0", 0));
    expect(s.mentions().some((m) => m.id === "0")).toBe(false);
    s.clear();
    expect(s.mentions()).toEqual([]);
  });
});
