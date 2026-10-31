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
const roomModes = { load: vi.fn(async () => {}) };
vi.mock("../stores/chatSettingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/chatSettingsStore")>()),
  createChatSettingsStore: () => roomModes,
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
    expect(roomModes.load).toHaveBeenCalledWith("a");
    await tick();
    // Viewers get a public row for each, and the mod action its own row.
    expect(ids("a").length).toBe(6);

    // Off screen too: the pane showing it may have the modes open.
    shown.id = "b";
    sink.event({
      kind: "mod_action",
      channel_id: "a",
      action: "slow",
    } as ChatEvent);
    expect(roomModes.load).toHaveBeenCalledTimes(2);
  });

  it("names a viewer's ban or timeout whichever source comes first", async () => {
    const s = holdSession(channel("a"));
    releaseHistory([]);
    const sink = sinks[0]!;
    const cleared = (user: string) =>
      sink.event({
        kind: "user_cleared",
        channel_id: "a",
        target_user_id: user,
        target_user_login: user,
        target_user_name: user.toUpperCase(),
      });
    cleared("x");
    sink.userClear({
      channel_id: "a",
      target_user_id: "x",
      duration_seconds: 600,
    });
    sink.userClear({
      channel_id: "a",
      target_user_id: "y",
      duration_seconds: null,
    });
    cleared("y");
    await tick();
    expect(
      s.chat.search((m) => m.notice !== null, 10).map((m) => m.notice),
    ).toEqual([
      { notice_type: "ban", system_message: "Y was banned" },
      { notice_type: "timeout", system_message: "X was timed out for 10m" },
    ]);
  });

  it("notes a ban and keeps its own badges and emotes, on screen or not", async () => {
    const badge = (version: string) => ({
      set: "subscriber",
      version,
      title: `Sub ${version}`,
      url_1x: "1x",
      url_2x: "2x",
      url_4x: "4x",
    });
    emoteBundle.mockResolvedValueOnce({
      broadcaster_id: "a",
      twitch_channel_badges: { badges: [badge("6")] },
      seventv_channel: { emotes: [{ code: "Clap", id: "1" }] },
    });
    const s = holdSession(channel("a"));
    const other = holdSession(channel("b"));
    releaseHistory([]);
    await Promise.resolve();
    expect(s.badges.resolve("subscriber", "6")?.title).toBe("Sub 6");
    expect(s.emotes.byCode("Clap")).toBeDefined();
    expect(other.emotes.byCode("Clap")).toBeUndefined();

    // A channel off screen still takes the bundle the host sends it.
    shown.id = "b";
    sinks[0]!.bundle({
      broadcaster_id: "a",
      twitch_channel_badges: { badges: [badge("12")] },
    } as never);
    expect(s.badges.resolve("subscriber", "12")?.title).toBe("Sub 12");

    sinks[0]!.banned({ broadcaster_id: "a" } as never);
    await tick();
    expect(ids("a")[0]).toMatch(/^banned-a-/);
  });
});
