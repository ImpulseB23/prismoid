import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../stores/chatStore";
import type { ChatEvent } from "./chatEvents";
import type { FeedSink } from "./chatRouter";
import type { Channel } from "./twitchChannel";

const sinks: FeedSink[] = [];
const detached = vi.fn();
vi.mock("./chatRouter", () => ({
  attachFeed: (sink: FeedSink) => {
    sinks.push(sink);
    return () => {
      sinks.splice(sinks.indexOf(sink), 1);
      detached();
    };
  },
}));
let releaseHistory: (rows: ChatMessage[]) => void = () => {};
vi.mock("./chatHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatHistory")>()),
  loadHistory: () => new Promise<ChatMessage[]>((r) => (releaseHistory = r)),
}));
const emoteBundle = vi.fn(async (): Promise<unknown> => null);
vi.mock("./emoteBundle", () => ({
  currentEmoteBundle: () => emoteBundle(),
}));
const shown = { id: "a" };
vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: shown.id }),
}));
const badges = { loadBadgeBundle: vi.fn() };
vi.mock("../stores/badgeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/badgeStore")>()),
  ...badges,
}));
const roomModes = { loadChatSettings: vi.fn(async () => {}) };
vi.mock("../stores/chatSettingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/chatSettingsStore")>()),
  ...roomModes,
}));
const roles = { mod: false, noteModerator: vi.fn() };
vi.mock("../stores/roleStore", () => ({
  canModerateIn: () => roles.mod,
  noteModerator: (id: string) => roles.noteModerator(id),
}));
vi.mock("../stores/userInfoStore", () => ({ ensureUserInfo: () => {} }));

const { holdSession, releaseSession, sessionFor } =
  await import("./chatSession");
const { setAuthStatus } = await import("../stores/authStore");
const { updateSettings } = await import("../stores/settingsStore");

const channel = (id: string) =>
  ({ id, login: id, display_name: id.toUpperCase() }) as Channel;

let seq = 0;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: `m${++seq}`,
    platform: "Twitch",
    channel_id: "a",
    platform_user_id: "7",
    username: "viewer",
    display_name: "Viewer",
    message_text: "hi",
    timestamp: seq,
    arrival_time: seq,
    effective_ts: seq,
    arrival_seq: seq,
    badges: [],
    emote_spans: [],
    notice: null,
    ...over,
  }) as unknown as ChatMessage;

// The chat store publishes on the next frame.
const tick = () => new Promise((r) => requestAnimationFrame(r));
const ids = (id: string) => {
  const chat = sessionFor(id)!.chat;
  const { start, count } = chat.viewport();
  return Array.from(
    { length: count },
    (_, i) => chat.getMessage(start + i)!.id,
  );
};

describe("chatSession", () => {
  afterEach(async () => {
    for (const id of ["a", "b"]) {
      while (sessionFor(id)) releaseSession(id);
    }
    detached.mockClear();
    vi.clearAllMocks();
    roles.mod = false;
    shown.id = "a";
    setAuthStatus(null);
    await updateSettings({ showModActions: true, ignoredLogins: [] });
  });

  it("shares one session per channel and closes it with the last holder", () => {
    const first = holdSession(channel("a"));
    expect(holdSession(channel("a"))).toBe(first);
    expect(sinks).toHaveLength(1);
    releaseSession("a");
    expect(sessionFor("a")).toBe(first);
    releaseSession("a");
    expect(sessionFor("a")).toBeUndefined();
    expect(detached).toHaveBeenCalledOnce();
  });

  it("keeps channels apart", () => {
    const a = holdSession(channel("a"));
    const b = holdSession(channel("b"));
    expect(a.chat).not.toBe(b.chat);
    expect(sessionFor("b")).toBe(b);
  });

  it("puts stored history ahead of live chat and drops what came both ways", async () => {
    const s = holdSession(channel("a"));
    expect(s.historyLoading()).toBe(true);
    const live = msg();
    sinks[0]!.messages([live]);
    releaseHistory([msg({ id: "old" }), live]);
    await Promise.resolve();
    await tick();
    expect(s.historyLoading()).toBe(false);
    expect(ids("a")).toEqual(["old", live.id]);

    sinks[0]!.messages([msg({ id: "next" }), msg({ username: "troll" })]);
    await updateSettings({ ignoredLogins: ["troll"] });
    sinks[0]!.messages([msg({ id: "hidden", username: "troll" })]);
    await tick();
    expect(ids("a")).not.toContain("hidden");
    expect(s.chatters.byLogin("viewer")?.id).toBe("7");
  });

  it("learns your mod role from your own badge", async () => {
    setAuthStatus({
      state: "logged_in",
      login: "me",
      user_id: "9",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    holdSession(channel("a"));
    releaseHistory([]);
    sinks[0]!.messages([msg({ platform_user_id: "9", is_mod: true })]);
    expect(roles.noteModerator).toHaveBeenCalledWith("a");
  });

  it("applies deletes, clears and mod actions to its own messages", async () => {
    const s = holdSession(channel("a"));
    releaseHistory([]);
    const target = msg();
    sinks[0]!.messages([target, msg({ platform_user_id: "8" })]);
    await Promise.resolve();
    await tick();
    const sink = sinks[0]!;
    sink.event({
      kind: "message_deleted",
      channel_id: "a",
      message_id: target.id,
    } as ChatEvent);
    expect(s.chat.findById(target.id)?.deleted).toBe(true);
    sink.event({
      kind: "user_cleared",
      channel_id: "a",
      target_user_id: "8",
    } as ChatEvent);
    sink.event({ kind: "chat_cleared", channel_id: "a" } as ChatEvent);
    sink.event({
      kind: "mod_action",
      channel_id: "a",
      action: "slow",
    } as ChatEvent);
    expect(roomModes.loadChatSettings).toHaveBeenCalledWith("a");
    await tick();
    // Viewers get a public row for each, and the mod action its own row.
    expect(ids("a").length).toBe(6);

    roles.mod = true;
    shown.id = "b";
    sink.event({
      kind: "mod_action",
      channel_id: "a",
      action: "slow",
    } as ChatEvent);
    expect(roomModes.loadChatSettings).toHaveBeenCalledOnce();
  });

  it("notes a ban and loads badges and emotes only for the channel on screen", async () => {
    const bundle = { broadcaster_id: "a" };
    emoteBundle.mockResolvedValueOnce(bundle);
    holdSession(channel("a"));
    releaseHistory([]);
    await Promise.resolve();
    expect(badges.loadBadgeBundle).toHaveBeenCalledWith(bundle);

    shown.id = "b";
    sinks[0]!.bundle(bundle as never);
    expect(badges.loadBadgeBundle).toHaveBeenCalledOnce();

    sinks[0]!.banned({ broadcaster_id: "a" } as never);
    await tick();
    expect(ids("a")[0]).toMatch(/^banned-a-/);
  });
});
