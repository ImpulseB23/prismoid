import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: "chan", display_name: "Chan" }),
}));

const { addMessages, clearMessages } = await import("../stores/chatStore");
const { default: ChatSearch } = await import("./ChatSearch");

let seq = 0;
const msg = (username: string, text: string, channel = "chan"): ChatMessage =>
  ({
    id: `m${++seq}`,
    platform: "Twitch",
    timestamp: seq,
    arrival_time: seq,
    effective_ts: seq,
    arrival_seq: seq,
    username,
    display_name: username,
    platform_user_id: username,
    channel_id: channel,
    message_text: text,
    badges: [],
    color: null,
    emote_spans: [],
  }) as unknown as ChatMessage;

describe("ChatSearch", () => {
  afterEach(() => {
    cleanup();
    clearMessages();
  });

  it("finds messages in the open channel, newest first", () => {
    addMessages([
      msg("nymn", "first clip"),
      msg("forsen", "clip here"),
      msg("nymn", "other channel clip", "elsewhere"),
      msg("nymn", "second clip"),
    ]);
    render(() => <ChatSearch open onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain(
      "Searches the chat",
    );
    fireEvent.input(screen.getByRole("searchbox"), {
      target: { value: "clip from:nymn" },
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("second clip");
    expect(screen.getByText("2 matches")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(() => <ChatSearch open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
