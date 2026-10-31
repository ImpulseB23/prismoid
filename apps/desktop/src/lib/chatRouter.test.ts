import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../stores/chatStore";
import type { ChatEvent } from "./chatEvents";
import type { FeedSink } from "./chatRouter";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const failing = new Set<string>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (failing.has(name)) throw new Error(`no ${name}`);
    handlers.set(name, cb);
    return () => handlers.delete(name);
  },
}));
const requestUserAttention = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention }),
  UserAttentionType: { Informational: 2 },
}));
vi.mock("./mentionAlert", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mentionAlert")>()),
  playChime: vi.fn(),
}));
const channels = { noteUnread: vi.fn(), markChannelBanned: vi.fn() };
vi.mock("../stores/channelStore", () => channels);
const held = { recordHeldMessage: vi.fn(), resolveHeldMessage: vi.fn() };
vi.mock("../stores/automodStore", () => held);
const manager = { applyPollUpdate: vi.fn(), applyPredictionUpdate: vi.fn() };
vi.mock("../stores/streamManagerStore", () => manager);
const ads = { applyAdBreak: vi.fn() };
vi.mock("../stores/adStore", () => ads);
const firsts = { markFirstMessage: vi.fn() };
vi.mock("../stores/firstMessageStore", () => firsts);
const pulse = { recordPulse: vi.fn() };
vi.mock("../stores/pulseStore", () => pulse);
vi.mock("../stores/paintStore", () => ({
  syncPaints: async () => () => {},
}));
const mentions = { recordMention: vi.fn() };
vi.mock("../stores/mentionsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/mentionsStore")>()),
  ...mentions,
}));

const { attachFeed, startChatRouter } = await import("./chatRouter");

let seq = 0;
const msg = (channel: string, text = "hi"): ChatMessage =>
  ({
    id: `m${++seq}`,
    platform: "Twitch",
    channel_id: channel,
    platform_user_id: "7",
    username: "viewer",
    display_name: "Viewer",
    message_text: text,
    arrival_time: seq,
    timestamp: seq,
    badges: [],
    notice: null,
  }) as unknown as ChatMessage;

function feed(channel: string | undefined) {
  const sink = {
    channel: () => channel,
    messages: vi.fn<FeedSink["messages"]>(),
    event: vi.fn<FeedSink["event"]>(),
    banned: vi.fn<FeedSink["banned"]>(),
    userClear: vi.fn<FeedSink["userClear"]>(),
    bundle: vi.fn<FeedSink["bundle"]>(),
  };
  return { sink, detach: attachFeed(sink) };
}

const emit = (name: string, payload: unknown) =>
  handlers.get(name)!({ payload });

describe("chatRouter", () => {
  let stop: () => void;
  const detaches: (() => void)[] = [];
  const open = (channel: string | undefined) => {
    const f = feed(channel);
    detaches.push(f.detach);
    return f.sink;
  };

  beforeEach(async () => {
    stop = await startChatRouter(() => "me");
  });

  afterEach(() => {
    stop();
    for (const d of detaches.splice(0)) d();
    vi.clearAllMocks();
    failing.clear();
  });

  it("gives each feed its channel and counts the rest as unread", () => {
    const a = open("a");
    const b = open("b");
    const [inA, inB, inC] = [msg("a"), msg("b"), msg("c")];
    emit("chat_messages", [inA, inB, inC]);
    expect(a.messages).toHaveBeenCalledWith([inA]);
    expect(b.messages).toHaveBeenCalledWith([inB]);
    expect(channels.noteUnread.mock.calls).toEqual([["c"]]);
    expect(pulse.recordPulse).toHaveBeenCalledTimes(3);
  });

  it("records a mention once however many feeds are open", () => {
    open("a");
    open("a");
    const mention = msg("a", "hey @me");
    emit("chat_messages", [mention, msg("a")]);
    expect(mentions.recordMention).toHaveBeenCalledExactlyOnceWith(mention);
  });

  it("keeps app-wide events out of feeds and routes the rest", () => {
    const a = open("a");
    const any = open(undefined);
    const events = [
      { kind: "automod_held", channel_id: "a" },
      { kind: "automod_resolved", channel_id: "a" },
      { kind: "poll_update", channel_id: "a" },
      { kind: "prediction_update", channel_id: "a" },
      { kind: "ad_break", channel_id: "a" },
      { kind: "message_deleted", channel_id: "a", message_id: "x" },
      { kind: "chat_cleared", channel_id: "b" },
    ] as unknown as ChatEvent[];
    emit("chat_events", events);
    expect(held.recordHeldMessage).toHaveBeenCalledOnce();
    expect(held.resolveHeldMessage).toHaveBeenCalledOnce();
    expect(manager.applyPollUpdate).toHaveBeenCalledOnce();
    expect(manager.applyPredictionUpdate).toHaveBeenCalledOnce();
    expect(ads.applyAdBreak).toHaveBeenCalledOnce();
    expect(a.event.mock.calls).toEqual([[events[5]]]);
    expect(any.event.mock.calls).toEqual([[events[5]], [events[6]]]);
  });

  it("marks bans, firsts and bundles, telling only that channel's feed", () => {
    const a = open("a");
    const b = open("b");
    emit("chat_banned", { broadcaster_id: "a" });
    expect(channels.markChannelBanned).toHaveBeenCalledWith("a");
    expect(a.banned).toHaveBeenCalledOnce();
    expect(b.banned).not.toHaveBeenCalled();

    const bundle = { broadcaster_id: "b" };
    emit("emote_bundle", bundle);
    expect(b.bundle).toHaveBeenCalledWith(bundle);
    expect(a.bundle).not.toHaveBeenCalled();

    emit("first_message", { channel_id: "a", message_id: "m" });
    expect(firsts.markFirstMessage).toHaveBeenCalledWith("m");

    const clear = {
      channel_id: "b",
      target_user_id: "7",
      duration_seconds: null,
    };
    emit("user_clear", clear);
    expect(b.userClear).toHaveBeenCalledWith(clear);
    expect(a.userClear).not.toHaveBeenCalled();
  });

  it("stops routing to a feed once it detaches", () => {
    const { sink, detach } = feed("a");
    detach();
    emit("chat_messages", [msg("a")]);
    expect(sink.messages).not.toHaveBeenCalled();
    expect(channels.noteUnread).toHaveBeenCalledWith("a");
  });

  it("keeps the other listeners when one fails to register", async () => {
    stop();
    failing.add("chat_banned");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stop = await startChatRouter(() => "me");
    expect(error).toHaveBeenCalledWith("chat router listen", expect.any(Error));
    expect(handlers.has("chat_messages")).toBe(true);
    error.mockRestore();
  });
});
