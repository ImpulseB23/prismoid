import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatStore } from "../stores/chatStore";
import type { BadgeStore } from "../stores/badgeStore";
import type { ModAction } from "./chatEvents";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(event, cb);
      return () => handlers.delete(event);
    },
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let releaseHistory: (msgs: ChatMessage[]) => void = () => {};
vi.mock("./userCardWindow", () => ({
  loadUserHistory: vi.fn(
    () => new Promise<ChatMessage[]>((r) => (releaseHistory = r)),
  ),
}));
const emoteBundle = vi.fn(async (): Promise<unknown> => null);
vi.mock("./emoteBundle", () => ({
  currentEmoteBundle: () => emoteBundle(),
}));
let sendLog: (actions: ModAction[]) => void = () => {};
vi.mock("./cardBridge", () => ({
  followModLog: vi.fn(async (_id: string, onLog: typeof sendLog) => {
    sendLog = onLog;
    return () => {};
  }),
}));
const getAuthStatus = vi.fn(async () => ({
  state: "logged_in",
  login: "me",
  user_id: "9",
  missing_scopes: [],
  enabled_scope_groups: [],
}));
vi.mock("./twitchAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twitchAuth")>()),
  getAuthStatus: () => getAuthStatus(),
}));
vi.mock("../stores/roleStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/roleStore")>()),
  loadModeratedChannels: vi.fn(async () => true),
}));
vi.mock("../stores/paintStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/paintStore")>()),
  syncPaints: vi.fn(async () => () => {}),
}));
vi.mock("../stores/settingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/settingsStore")>()),
  followSettingsElsewhere: vi.fn(async () => () => {}),
}));

const { showCardUser, startCardSession } = await import("./cardSession");
const { createChatStore } = await import("../stores/chatStore");
const { createBadgeStore } = await import("../stores/badgeStore");
const { modActionsFor } = await import("../stores/modLogStore");
const { authStatus } = await import("../stores/authStore");

let seq = 0;
const msg = (id: string, user = "u1", channel = "c"): ChatMessage =>
  ({
    id,
    platform: "Twitch",
    timestamp: ++seq,
    arrival_time: seq,
    effective_ts: seq,
    arrival_seq: seq,
    username: user,
    display_name: user,
    platform_user_id: user,
    channel_id: channel,
    message_text: id,
    badges: [],
    emote_spans: [],
    notice: null,
  }) as unknown as ChatMessage;

const card = {
  channel_id: "c",
  platform_user_id: "u1",
  username: "u1",
  display_name: "U1",
  color: null,
  badges: [],
};

// The chat store publishes on the next frame.
const tick = () => new Promise((r) => requestAnimationFrame(r));

describe("cardSession", () => {
  let chat: ChatStore;
  let badges: BadgeStore;

  beforeEach(() => {
    handlers.clear();
    chat = createChatStore();
    badges = createBadgeStore();
  });

  it("starts with the signed-in session", async () => {
    const stop = await startCardSession();
    expect(authStatus()).toMatchObject({ login: "me" });
    stop();
  });

  it("starts signed out when the session can't be read", async () => {
    getAuthStatus.mockRejectedValueOnce(new Error("keyring"));
    const stop = await startCardSession();
    expect(authStatus()).toEqual({ state: "logged_out" });
    stop();
  });

  it("shows their stored and live messages, and nobody else's", async () => {
    const shown = showCardUser(card, chat, badges);
    await Promise.resolve();
    handlers.get("chat_messages")!({
      payload: [msg("live"), msg("other", "u2"), msg("away", "u1", "x")],
    });
    releaseHistory([msg("old"), msg("live")]);
    const stop = await shown;
    await tick();
    expect(chat.recentByUser("u1", 10).map((m) => m.id)).toEqual([
      "old",
      "live",
    ]);
    stop();
  });

  it("adds their messages that arrive after history loaded", async () => {
    const shown = showCardUser(card, chat, badges);
    releaseHistory([]);
    const stop = await shown;
    handlers.get("chat_messages")!({ payload: [msg("later")] });
    await tick();
    expect(chat.recentByUser("u1", 10).map((m) => m.id)).toEqual(["later"]);
    stop();
  });

  it("loads the channel's badges", async () => {
    const sub = {
      set: "subscriber",
      version: "6",
      title: "6-Month Subscriber",
      url_1x: "1x",
      url_2x: "2x",
      url_4x: "4x",
    };
    emoteBundle.mockResolvedValueOnce({
      twitch_channel_badges: { badges: [sub] },
    });
    const shown = showCardUser(card, chat, badges);
    releaseHistory([]);
    const stop = await shown;
    expect(badges.resolve("subscriber", "6")?.title).toBe("6-Month Subscriber");
    stop();
  });

  it("still opens when the emotes fail to load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    emoteBundle.mockRejectedValueOnce(new Error("offline"));
    const shown = showCardUser(card, chat, badges);
    releaseHistory([]);
    const stop = await shown;
    expect(error).toHaveBeenCalledWith("card emotes", expect.any(Error));
    error.mockRestore();
    stop();
  });

  it("keeps the mod log the main window sends, newest first", async () => {
    const shown = showCardUser(card, chat, badges);
    releaseHistory([]);
    const stop = await shown;
    const action = (n: number) =>
      ({
        kind: "mod_action",
        action: `a${n}`,
        target_user_id: "u1",
      }) as ModAction;
    sendLog([action(2), action(1)]);
    expect(modActionsFor("u1").map((a) => a.action)).toEqual(["a2", "a1"]);
    stop();
  });
});
