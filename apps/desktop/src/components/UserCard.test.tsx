import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

vi.mock("../stores/paintStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/paintStore")>()),
  shownPaint: (id: string) =>
    id === "7"
      ? {
          id: "01HEBYHWN0000EV2G1SJ85XJQR",
          name: "Firebrand",
          function: "RADIAL_GRADIENT",
          angle: 0,
          shape: "circle",
          repeat: false,
          stops: [{ at: 0.15, color: "#fff700ff" }],
          shadows: [],
        }
      : undefined,
}));

const { default: UserCard } = await import("./UserCard");
const { isUserHighlighted } = await import("../stores/settingsStore");

const viewer = {
  channel_id: "1",
  platform_user_id: "42",
  username: "viewer",
  display_name: "Viewer",
  color: null,
  badges: [],
};

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
    const rows = screen.getByRole("dialog").querySelectorAll(".msg-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classList.contains("msg-row--mention")).toBe(true);
    expect(rows[1]!.classList.contains("msg-row--mention")).toBe(false);
  });

  it("toggles highlighting everything they say", async () => {
    render(() => <UserCard login="me" onClose={() => {}} user={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    await vi.waitFor(() => expect(isUserHighlighted("viewer")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Stop highlighting" }));
    await vi.waitFor(() => expect(isUserHighlighted("viewer")).toBe(false));
  });

  it("paints the name of a 7TV paint wearer", () => {
    render(() => (
      <UserCard
        login="me"
        onClose={() => {}}
        user={{ ...viewer, platform_user_id: "7" }}
      />
    ));
    const name = screen.getByText("Viewer", { selector: ".user-card__name" });
    expect(name.classList.contains("name--painted")).toBe(true);
  });

  it("leaves other names plain", () => {
    render(() => <UserCard login="me" onClose={() => {}} user={viewer} />);
    const name = screen.getByText("Viewer", { selector: ".user-card__name" });
    expect(name.classList.contains("name--painted")).toBe(false);
  });
});
