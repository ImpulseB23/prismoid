import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";

vi.mock("../stores/channelStore", () => ({
  channelTabs: () => [{ id: "1", display_name: "Chan" }],
}));

const { recordMention, setMentionsOpen, mentionsOpen, mentions } =
  await import("../stores/mentionsStore");
const { default: Mentions } = await import("./Mentions");
const { jumpRequest } = await import("../stores/jumpStore");

const said = {
  id: "m1",
  channel_id: "1",
  timestamp: Date.now(),
  display_name: "Viewer",
  color: null,
  message_text: "hi @me",
  emote_spans: [],
} as unknown as ChatMessage;

describe("Mentions", () => {
  afterEach(cleanup);

  it("lists mentions and jumps to the message", () => {
    render(() => <Mentions />);
    setMentionsOpen(true);
    expect(screen.getByRole("dialog").textContent).toContain("No mentions yet");
    recordMention(said);
    const row = screen.getByRole("button", { name: /Viewer/ });
    expect(row.closest("li")?.textContent).toContain("Chan");
    fireEvent.click(row);
    expect(jumpRequest()).toEqual({ channel_id: "1", message_id: "m1" });
    expect(mentionsOpen()).toBe(false);
  });

  it("clears the list and closes on Escape", () => {
    render(() => <Mentions />);
    recordMention({ ...said, id: "m2" });
    setMentionsOpen(true);
    const before = mentions().length;
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mentions()).toHaveLength(before);
    fireEvent.click(screen.getByRole("button", { name: "Clear all?" }));
    expect(mentions()).toEqual([]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(mentionsOpen()).toBe(false);
  });
});
