import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage, ChatStore } from "../stores/chatStore";
import { contextMenu } from "../stores/contextMenuStore";

const said = (id: string, text: string) =>
  ({
    id,
    channel_id: "1",
    timestamp: 0,
    display_name: "Viewer",
    message_text: text,
    emote_spans: [],
    badges: [],
    notice: null,
  }) as unknown as ChatMessage;

const follows = { since: null as string | null };
const followCalls: [string, string][] = [];
vi.mock("../lib/twitchChannel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/twitchChannel")>()),
  getFollowSince: async (channel: string, user: string) => {
    followCalls.push([channel, user]);
    return follows.since;
  },
  getSubAge: async () => ({
    hidden: false,
    kind: "paid",
    tier: "1",
    months: 21,
    streak: 12,
    followed_at: null,
  }),
  getFollowerCount: async () => 1200,
}));
const mod = {
  timeoutUser: vi.fn(async () => {}),
  banUser: vi.fn(async () => {}),
  unbanUser: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
};
vi.mock("../lib/twitchAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/twitchAuth")>()),
  ...mod,
}));
const chat = {
  viewport: () => ({ start: 0, count: 2 }),
  messageRevision: () => 0,
  recentByUser: () => [
    said("a", "hey @Me how is it going"),
    said("b", "nothing to see"),
  ],
  markDeleted: vi.fn(),
} as unknown as ChatStore;
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
const { createBadgeStore } = await import("../stores/badgeStore");
const { isUserHighlighted } = await import("../stores/settingsStore");
const { setAuthStatus } = await import("../stores/authStore");
const { clearModLog, recordModAction } = await import("../stores/modLogStore");

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
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
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
    const rows = screen.getByRole("main").querySelectorAll(".card-line");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classList.contains("card-line--mention")).toBe(true);
    expect(rows[1]!.classList.contains("card-line--mention")).toBe(false);
    // The lines read like chat: the name sits before the words.
    expect(rows[0]!.textContent).toContain("Viewer: ");
  });

  it("toggles highlighting everything they say", async () => {
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    await vi.waitFor(() => expect(isUserHighlighted("viewer")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Stop highlighting" }));
    await vi.waitFor(() => expect(isUserHighlighted("viewer")).toBe(false));
  });

  it("paints the name of a 7TV paint wearer", () => {
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={{ ...viewer, platform_user_id: "7" }}
      />
    ));
    const name = screen.getByText("Viewer", { selector: ".user-card__name" });
    expect(name.classList.contains("name--painted")).toBe(true);
  });

  it("leaves other names plain", () => {
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    const name = screen.getByText("Viewer", { selector: ".user-card__name" });
    expect(name.classList.contains("name--painted")).toBe(false);
  });
});

describe("UserCard follow age", () => {
  afterEach(() => {
    cleanup();
    setAuthStatus(null);
    follows.since = null;
    followCalls.length = 0;
  });

  it("shows how long you've followed the channel on your own card", async () => {
    setAuthStatus({
      state: "logged_in",
      login: "viewer",
      user_id: "42",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    follows.since = "2021-03-04T00:00:00Z";
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="viewer"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    expect(await screen.findByText("Following")).toBeTruthy();
    expect(followCalls).toEqual([[viewer.channel_id, "42"]]);
    expect(screen.queryByText("This session")).toBeNull();
  });

  it("does not ask Twitch about others where it would not answer", () => {
    setAuthStatus({
      state: "logged_in",
      login: "me",
      user_id: "5",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    expect(followCalls).toEqual([]);
    expect(screen.queryByText("Following")).toBeNull();
  });
});

describe("UserCard moderation", () => {
  afterEach(() => {
    cleanup();
    setAuthStatus(null);
    for (const f of Object.values(mod)) f.mockClear();
  });

  it("moderates in the card's channel, mentions and jumps", async () => {
    // Signed in as the channel's streamer, so the card's channel is theirs.
    setAuthStatus({
      state: "logged_in",
      login: "streamer",
      user_id: viewer.channel_id,
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    const onMention = vi.fn();
    const onJump = vi.fn();
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="streamer"
        onClose={() => {}}
        onMention={onMention}
        onJump={onJump}
        user={viewer}
      />
    ));
    const timeouts = screen.getByRole("group", { name: "Timeout" });
    expect(
      [...timeouts.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(["1s", "30s", "1m", "5m", "30m", "1h", "1d", "7d"]);
    fireEvent.click(
      [...timeouts.querySelectorAll("button")].find(
        (b) => b.textContent === "1m",
      )!,
    );
    expect(mod.timeoutUser).toHaveBeenCalledWith(
      viewer.channel_id,
      viewer.platform_user_id,
      60,
      undefined,
    );
    await screen.findByText(/Timed out/);

    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    expect(mod.banUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));
    expect(mod.banUser).toHaveBeenCalledWith(
      viewer.channel_id,
      viewer.platform_user_id,
      undefined,
    );
    await screen.findByText(`Banned ${viewer.display_name}.`);

    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    expect(mod.unbanUser).toHaveBeenCalledOnce();
    await screen.findByText(`Unbanned ${viewer.display_name}.`);

    // Deleting and jumping live on a message's right-click menu.
    const line = screen.getByRole("main").querySelector(".card-line")!;
    const choose = (label: string) => {
      fireEvent.contextMenu(line);
      const items = contextMenu()!.items;
      const found = items.find((i) => i.kind === "item" && i.label === label);
      if (found?.kind === "item") found.onSelect();
    };
    choose("Delete message");
    expect(mod.deleteMessage).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /Mention/ }));
    expect(onMention).toHaveBeenCalledWith(viewer.username);
    choose("Jump to message");
    expect(onJump).toHaveBeenCalledOnce();
  });

  it("shows a failed action's reason", async () => {
    setAuthStatus({
      state: "logged_in",
      login: "streamer",
      user_id: viewer.channel_id,
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    mod.unbanUser.mockRejectedValueOnce("not banned");
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="streamer"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    await screen.findByText("not banned");
  });
});

describe("UserCard mod history", () => {
  afterEach(() => {
    cleanup();
    clearModLog();
  });

  it("lists what moderators did to them", () => {
    recordModAction({
      kind: "mod_action",
      channel_id: viewer.channel_id,
      timestamp: 0,
      moderator_login: "mo",
      moderator_name: "Mo",
      action: "timeout",
      target_user_id: viewer.platform_user_id,
      target_user_login: viewer.username,
      target_user_name: viewer.display_name,
      reason: "spam",
      duration_seconds: 60,
      message_id: "",
      message_body: "",
      wait_time_seconds: null,
      follow_duration_minutes: null,
      viewer_count: null,
      terms: [],
      moderator_message: "",
    });
    render(() => (
      <UserCard
        chat={chat}
        badges={createBadgeStore()}
        login="me"
        onClose={() => {}}
        onMention={() => {}}
        onJump={() => {}}
        user={viewer}
      />
    ));
    fireEvent.click(screen.getByRole("tab", { name: /Mod history/ }));
    expect(screen.getByText(/Mo timed out Viewer for .*: spam/)).toBeTruthy();
  });
});
