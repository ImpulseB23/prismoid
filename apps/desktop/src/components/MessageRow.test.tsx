import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { default: MessageRow } = await import("./MessageRow");

const msg = (extra: Partial<ChatMessage>): ChatMessage =>
  ({
    id: "m",
    platform: "Twitch",
    timestamp: 0,
    display_name: "Gifter",
    username: "gifter",
    platform_user_id: "1",
    channel_id: "c",
    message_text: "",
    emote_spans: [],
    badges: [],
    color: null,
    notice: null,
    ...extra,
  }) as ChatMessage;

const text = () => document.querySelector(".msg-row__text")!.textContent;

describe("MessageRow", () => {
  afterEach(cleanup);

  it("shows a notice's line, so subs and timeouts are never blank", () => {
    render(() => (
      <ol>
        <MessageRow
          msg={msg({
            notice: {
              notice_type: "community_sub_gift",
              system_message: "Gifter gifted 5 subs to the community!",
            },
          })}
        />
      </ol>
    ));
    expect(text()).toBe("Gifter gifted 5 subs to the community!");
  });

  it("puts the chatter's own words after the notice", () => {
    render(() => (
      <ol>
        <MessageRow
          msg={msg({
            message_text: "love this stream",
            notice: { notice_type: "resub", system_message: "Resubscribed." },
          })}
        />
      </ol>
    ));
    expect(text()).toBe("Resubscribed. love this stream");
    expect(screen.getByText("love this stream")).toBeTruthy();
  });

  it("takes a click on its text unless text is being selected", () => {
    const onClick = vi.fn();
    render(() => (
      <ol>
        <MessageRow
          msg={msg({ message_text: "hello there" })}
          onClick={onClick}
        />
      </ol>
    ));
    const body = document.querySelector(".msg-row__text")!;
    fireEvent.click(body);
    expect(onClick).toHaveBeenCalledTimes(1);

    // The keyboard's jump button fires once, not again through the row.
    fireEvent.click(document.querySelector(".msg-row__hit")!);
    expect(onClick).toHaveBeenCalledTimes(2);

    const range = document.createRange();
    range.selectNodeContents(body);
    window.getSelection()!.addRange(range);
    fireEvent.click(body);
    expect(onClick).toHaveBeenCalledTimes(2);
    window.getSelection()!.removeAllRanges();
  });
});
