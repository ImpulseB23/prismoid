import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { HeldMessage } from "../lib/chatEvents";

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: "1", display_name: "Chan" }),
}));
const manage =
  vi.fn<(channel: string, id: string, action: string) => Promise<void>>();
vi.mock("../lib/twitchAuth", () => ({
  manageHeldMessage: (c: string, id: string, a: string) => manage(c, id, a),
}));

const { setAuthStatus } = await import("../stores/authStore");
const { clearHeldMessages, recordHeldMessage, resolveHeldMessage } =
  await import("../stores/automodStore");
const {
  default: AutomodQueue,
  heldOutcome,
  heldReason,
} = await import("./AutomodQueue");

const held = (id: string, over: Partial<HeldMessage> = {}): HeldMessage => ({
  kind: "automod_held",
  channel_id: "1",
  message_id: id,
  user_id: "42",
  user_login: "chatter",
  user_name: "Chatter",
  text: `bad words ${id}`,
  reason: "automod",
  category: "aggressive",
  level: 3,
  held_at: 0,
  ...over,
});

describe("heldReason", () => {
  it("names the filter that caught it", () => {
    expect(heldReason(held("a"))).toBe("aggressive, level 3");
    expect(heldReason(held("a", { category: "", level: null }))).toBe(
      "AutoMod",
    );
    expect(heldReason(held("a", { reason: "blocked_term" }))).toBe(
      "Blocked term",
    );
    expect(heldReason(held("a", { reason: "blocked_link" }))).toBe(
      "Blocked link",
    );
  });
});

describe("heldOutcome", () => {
  it("says who resolved it when known", () => {
    const message = held("a");
    expect(heldOutcome({ message, status: "approved", by: "Mod" })).toBe(
      "Allowed by Mod",
    );
    expect(heldOutcome({ message, status: "denied", by: "" })).toBe("Denied");
    expect(heldOutcome({ message, status: "expired", by: "" })).toBe("Expired");
    expect(heldOutcome({ message, status: "pending", by: "" })).toBe("");
  });
});

describe("AutomodQueue", () => {
  afterEach(() => {
    cleanup();
    clearHeldMessages();
    manage.mockReset();
    setAuthStatus(null);
  });

  it("lists held messages and allows one", async () => {
    manage.mockResolvedValue(undefined);
    render(() => <AutomodQueue />);
    expect(document.body.textContent).toContain("Nothing held");

    recordHeldMessage(held("a"));
    recordHeldMessage(held("b", { reason: "blocked_link" }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("bad words b");
    expect(items[0].textContent).toContain("Blocked link");
    expect(items[1].textContent).toContain("Chatter");
    expect(items[1].textContent).toContain("aggressive, level 3");

    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[1]);
    expect(manage).toHaveBeenCalledWith("1", "a", "ALLOW");
    expect(await screen.findByText("Allowed")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
  });

  it("shows another mod's decision and an expiry", () => {
    render(() => <AutomodQueue />);
    recordHeldMessage(held("a"));
    recordHeldMessage(held("b"));
    resolveHeldMessage({
      kind: "automod_resolved",
      channel_id: "1",
      message_id: "a",
      status: "denied",
      moderator_login: "other",
      moderator_name: "Other",
    });
    resolveHeldMessage({
      kind: "automod_resolved",
      channel_id: "1",
      message_id: "b",
      status: "expired",
      moderator_login: "",
      moderator_name: "",
    });
    expect(screen.getByText("Denied by Other")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("keeps the row and says why when Twitch refuses", async () => {
    manage.mockRejectedValueOnce({
      kind: "helix",
      code: "helix",
      message: "message not found",
    });
    render(() => <AutomodQueue />);
    recordHeldMessage(held("a"));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(manage).toHaveBeenCalledWith("1", "a", "DENY");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "message not found",
    );
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();

    manage.mockRejectedValueOnce("sidecar went away");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("sidecar went away"),
    );
  });

  it("asks for a reconnect when the grant lacks the scope", () => {
    setAuthStatus({
      state: "logged_in",
      user_id: "1",
      login: "me",
      missing_scopes: ["moderator:manage:automod"],
      enabled_scope_groups: [],
    });
    render(() => <AutomodQueue />);
    expect(document.body.textContent).toContain("Reconnect in Settings");
  });
});
