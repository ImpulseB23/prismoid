import { describe, expect, it } from "vitest";
import { createChatSettingsStore } from "./chatSettingsStore";
import type { ChatSettings, ChatSettingsPatch } from "../lib/twitchChannel";

const base: ChatSettings = {
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

describe("chatSettingsStore", () => {
  it("loads and applies, keeping the last server state", async () => {
    const patches: [string, ChatSettingsPatch][] = [];
    const store = createChatSettingsStore(
      async () => base,
      async (channel, p) => {
        patches.push([channel, p]);
        return { ...base, slow_mode: true, slow_mode_wait_time: 30 };
      },
    );
    await store.apply({ slow_mode: true });
    expect(patches).toEqual([]);
    await store.load("c1");
    expect(store.settings()).toEqual(base);
    await store.apply({ slow_mode: true, slow_mode_wait_time: 30 });
    expect(patches).toEqual([
      ["c1", { slow_mode: true, slow_mode_wait_time: 30 }],
    ]);
    expect(store.settings()?.slow_mode).toBe(true);
    expect(store.busy()).toBe(false);
  });

  it("surfaces errors and clears them on the next success", async () => {
    let fail = true;
    const store = createChatSettingsStore(
      async () => {
        if (fail) throw { kind: "helix", status: 403, message: "nope" };
        return base;
      },
      async () => base,
    );
    await store.load("c1");
    expect(store.error()).toEqual({
      kind: "helix",
      status: 403,
      message: "nope",
    });
    fail = false;
    await store.load("c1");
    expect(store.error()).toBeNull();
    store.clear();
    expect(store.settings()).toBeNull();
  });

  it("drops another channel's modes as soon as a new channel loads", async () => {
    let answer!: (s: ChatSettings) => void;
    const store = createChatSettingsStore(
      (channel) =>
        channel === "c1"
          ? Promise.resolve({ ...base, emote_mode: true })
          : new Promise((r) => (answer = r)),
      async () => base,
    );
    await store.load("c1");
    expect(store.settings()?.emote_mode).toBe(true);
    const pending = store.load("c2");
    expect(store.settings()).toBeNull();
    answer(base);
    await pending;
    expect(store.settings()).toEqual(base);
  });

  it("keeps the shown modes while the same channel reloads", async () => {
    let answer!: (s: ChatSettings) => void;
    let calls = 0;
    const store = createChatSettingsStore(
      () =>
        calls++ === 0
          ? Promise.resolve(base)
          : new Promise((r) => (answer = r)),
      async () => base,
    );
    await store.load("c1");
    const pending = store.load("c1");
    expect(store.settings()).toEqual(base);
    answer({ ...base, slow_mode: true });
    await pending;
    expect(store.settings()?.slow_mode).toBe(true);
  });
});
