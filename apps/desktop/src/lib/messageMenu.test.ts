import { describe, expect, it, vi } from "vitest";
import { messageMenuItems, type MessageMenuActions } from "./messageMenu";
import type { ChatMessage } from "../stores/chatStore";

const msg: ChatMessage = {
  id: "m1",
  platform: "Twitch",
  timestamp: 0,
  arrival_time: 0,
  effective_ts: 0,
  arrival_seq: 0,
  username: "viewer",
  display_name: "Viewer",
  platform_user_id: "42",
  channel_id: "1",
  message_text: "hello",
  badges: [],
  is_mod: false,
  is_subscriber: false,
  is_broadcaster: false,
  color: null,
  reply_to: null,
  reply_parent: null,
  notice: null,
  emote_spans: [],
};

const timeouts = [60, 600, 3600];

function actions(): MessageMenuActions {
  return {
    reply: vi.fn(),
    copyMessage: vi.fn(),
    copyLogin: vi.fn(),
    mention: vi.fn(),
    viewProfile: vi.fn(),
    openOnTwitch: vi.fn(),
    toggleIgnore: vi.fn(),
    deleteMessage: vi.fn(),
    timeout: vi.fn(),
    customTimeout: vi.fn(),
    warn: vi.fn(),
    ban: vi.fn(),
    unban: vi.fn(),
  };
}

const labels = (items: ReturnType<typeof messageMenuItems>) =>
  items.map((i) => (i.kind === "item" ? i.label : "---"));

describe("messageMenuItems", () => {
  it("offers viewer actions without moderation when not a mod", () => {
    const got = labels(
      messageMenuItems(
        msg,
        { canModerate: false, ignored: false, own: false, timeouts },
        actions(),
      ),
    );
    expect(got).toEqual([
      "Reply",
      "Copy message",
      "---",
      "View profile",
      "Copy name",
      "Mention @viewer",
      "Open on Twitch",
      "Ignore",
    ]);
  });

  it("adds delete, the configured timeouts, ban and unban for moderators", () => {
    const act = actions();
    const items = messageMenuItems(
      msg,
      { canModerate: true, ignored: true, own: false, timeouts },
      act,
    );
    const got = labels(items);
    expect(got).toContain("Unignore");
    expect(got).toContain("Delete message");
    expect(got.filter((l) => l.startsWith("Timeout"))).toEqual([
      "Timeout 1m",
      "Timeout 10m",
      "Timeout 1h",
    ]);
    expect(got.slice(got.indexOf("Delete message"))).toEqual([
      "Delete message",
      "Warn…",
      "Timeout 1m",
      "Timeout 10m",
      "Timeout 1h",
      "Custom timeout…",
      "Ban",
      "Unban",
    ]);
    const tenMinutes = items.find(
      (i) => i.kind === "item" && i.label === "Timeout 10m",
    );
    if (tenMinutes?.kind === "item") tenMinutes.onSelect();
    expect(act.timeout).toHaveBeenCalledWith(600);
  });

  it("lets a mod delete their own message but never punish themselves", () => {
    const got = labels(
      messageMenuItems(
        msg,
        { canModerate: true, ignored: false, own: true, timeouts },
        actions(),
      ),
    );
    expect(got).toContain("Delete message");
    expect(got).not.toContain("Ban");
    expect(got).not.toContain("Warn…");
    expect(got.some((l) => l.includes("imeout"))).toBe(false);
    expect(got).not.toContain("Ignore");
    expect(got).toContain("Copy message");
  });

  it("skips reply and delete on notices and pending rows", () => {
    const notice = {
      ...msg,
      notice: { notice_type: "mod_action", system_message: "x" },
      message_text: "",
    };
    const got = labels(
      messageMenuItems(
        notice,
        { canModerate: true, ignored: false, own: false, timeouts },
        actions(),
      ),
    );
    expect(got).not.toContain("Reply");
    expect(got).not.toContain("Copy message");
    expect(got).not.toContain("Delete message");
    expect(got).toContain("Ban");
  });
});
