import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../stores/channelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/channelStore")>()),
  activeChannel: () => ({ id: "c", login: "chan", display_name: "Chan" }),
}));
vi.mock("../stores/badgeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/badgeStore")>()),
  resolveBadge: (set: string) =>
    set === "subscriber"
      ? {
          title: "6-Month Subscriber",
          url_1x: "s1",
          url_2x: "s2",
          url_4x: "s4",
        }
      : undefined,
}));
vi.mock("./TwitchReconnect", () => ({
  default: (p: { title: string }) => <p>{p.title}</p>,
}));

const { default: AccountPanel } = await import("./AccountPanel");
const { setAuthStatus } = await import("../stores/authStore");
const { settingsOpen, settingsSection, setSettingsOpen } =
  await import("../stores/settingsPanelStore");

function renderPanel(onSignOut = vi.fn(), onClose = vi.fn()) {
  render(() => (
    <AccountPanel
      open
      login="viewer"
      displayName="Viewer"
      picture={undefined}
      badges={[]}
      onClose={onClose}
      onSignOut={onSignOut}
    />
  ));
  return { onSignOut, onClose };
}

describe("AccountPanel", () => {
  afterEach(() => {
    cleanup();
    setAuthStatus(null);
    setSettingsOpen(false);
  });

  it("asks before signing out", () => {
    const { onSignOut } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out?" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("opens the account settings", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
    expect(settingsOpen()).toBe(true);
    expect(settingsSection()).toBe("account");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the channel, connections and a reconnect when one is due", () => {
    setAuthStatus({
      state: "logged_in",
      login: "viewer",
      user_id: "1",
      missing_scopes: ["user:read:follows"],
      enabled_scope_groups: [],
    });
    renderPanel();
    expect(screen.getByText("In Chan's chat")).toBeTruthy();
    expect(screen.getByText("Signed in as viewer")).toBeTruthy();
    expect(screen.getByText("YouTube")).toBeTruthy();
    expect(screen.getByText("Twitch needs new permissions")).toBeTruthy();
  });

  it("shows the picture and your badges in the channel", () => {
    render(() => (
      <AccountPanel
        open
        login="viewer"
        displayName="Viewer"
        picture="https://example.test/me.png"
        badges={[
          { set_id: "subscriber", id: "6" },
          { set_id: "unknown", id: "1" },
        ]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    expect(screen.getByText("6-Month Subscriber")).toBeTruthy();
    expect(
      screen.getByRole("dialog").querySelector("img.account__picture"),
    ).toBeTruthy();
  });

  it("closes when clicking outside", () => {
    const { onClose } = renderPanel();
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
