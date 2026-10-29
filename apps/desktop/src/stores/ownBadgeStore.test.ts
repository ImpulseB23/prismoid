import { describe, expect, it } from "vitest";
import { createOwnBadgeStore } from "./ownBadgeStore";
import type { ChatMessage } from "./chatStore";
import type { StorageLike } from "./channelStore";

function memStorage(data: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const sub = [{ set_id: "subscriber", id: "12" }];
const vip = [{ set_id: "vip", id: "1" }];

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    platform: "Twitch",
    timestamp: 100,
    arrival_time: 100,
    effective_ts: 100,
    arrival_seq: 1,
    username: "me",
    display_name: "Me",
    platform_user_id: "1",
    channel_id: "chan",
    message_text: "hi",
    badges: sub,
    is_mod: false,
    is_subscriber: true,
    is_broadcaster: false,
    color: null,
    reply_to: null,
    reply_parent: null,
    notice: null,
    emote_spans: [],
    ...over,
  };
}

describe("ownBadgeStore", () => {
  it("keeps the badges from the user's newest message per channel", () => {
    const store = createOwnBadgeStore(memStorage());
    store.note(msg({ timestamp: 200 }), "1");
    store.note(msg({ timestamp: 100, badges: vip }), "1");
    expect(store.badges("chan")).toEqual(sub);
    store.note(msg({ timestamp: 300, badges: vip }), "1");
    expect(store.badges("chan")).toEqual(vip);
    expect(store.badges("other")).toBeUndefined();
  });

  it("ignores other people, notices and unsent messages", () => {
    const store = createOwnBadgeStore(memStorage());
    store.note(msg({ platform_user_id: "2" }), "1");
    store.note(
      msg({ notice: { notice_type: "resub", system_message: "x" } }),
      "1",
    );
    store.note(msg({ status: "pending" }), "1");
    expect(store.badges("chan")).toBeUndefined();
  });

  it("remembers them across restarts and drops malformed data", () => {
    const storage = memStorage();
    createOwnBadgeStore(storage).note(msg({}), "1");
    expect(createOwnBadgeStore(storage).badges("chan")).toEqual(sub);

    const broken = memStorage({
      "prismoid.ownBadges": JSON.stringify({
        chan: { badges: [{ set_id: 3 }], at: 1 },
        ok: { badges: vip, at: 1 },
      }),
    });
    const store = createOwnBadgeStore(broken);
    expect(store.badges("chan")).toBeUndefined();
    expect(store.badges("ok")).toEqual(vip);
    expect(
      createOwnBadgeStore(memStorage({ "prismoid.ownBadges": "{nope" })).badges(
        "ok",
      ),
    ).toBeUndefined();
  });
});
