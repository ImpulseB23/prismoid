import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";

const said = (id: string, text: string) =>
  ({
    id,
    channel_id: "1",
    timestamp: 0,
    message_text: text,
    emote_spans: [],
  }) as unknown as ChatMessage;

vi.mock("../stores/chatStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/chatStore")>()),
  recentMessagesByUser: () => [
    said("a", "hey @Me how is it going"),
    said("b", "nothing to see"),
  ],
}));
vi.mock("../stores/userInfoStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/userInfoStore")>()),
  ensureUserInfo: () => {},
}));

const { default: UserCard } = await import("./UserCard");

describe("UserCard", () => {
  afterEach(cleanup);

  it("highlights recent messages that mention you", () => {
    render(() => (
      <UserCard
        login="me"
        onClose={() => {}}
        user={{
          channel_id: "1",
          platform_user_id: "42",
          username: "viewer",
          display_name: "Viewer",
          color: null,
          badges: [],
        }}
      />
    ));
    const rows = screen.getByRole("dialog").querySelectorAll(".user-card__msg");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classList.contains("user-card__msg--mention")).toBe(true);
    expect(rows[1]!.classList.contains("user-card__msg--mention")).toBe(false);
  });
});
