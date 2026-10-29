import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { AuthStatus, ScopeGroup } from "../../lib/twitchAuth";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const { default: ScopeGroupCard } = await import("./ScopeGroupCard");
const { authStatus, setAuthStatus } = await import("../../stores/authStore");

const status = (groups: ScopeGroup[], missing: string[]): AuthStatus => ({
  state: "logged_in",
  login: "me",
  user_id: "7",
  missing_scopes: missing,
  enabled_scope_groups: groups,
});

describe("ScopeGroupCard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setAuthStatus(null);
  });

  it("turns a group on, asks for the reconnect, and turns it off", async () => {
    setAuthStatus(status([], []));
    invoke.mockResolvedValueOnce(status(["ads"], ["channel:read:ads"]));
    render(() => <ScopeGroupCard group="ads" />);
    expect(screen.getByText("Run your ads from here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("One more step on Twitch")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("twitch_enable_scope_group", {
      group: "ads",
    });
    expect(
      screen.getByRole("button", { name: "Reconnect Twitch" }),
    ).toBeTruthy();

    invoke.mockResolvedValueOnce(status([], []));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off again" }));
    expect(await screen.findByText("Run your ads from here")).toBeTruthy();
    expect(invoke).toHaveBeenLastCalledWith("twitch_disable_scope_group", {
      group: "ads",
    });
    expect(authStatus()).toEqual(status([], []));
  });

  it("says when turning on failed", async () => {
    setAuthStatus(status([], []));
    invoke.mockRejectedValueOnce({ kind: "keychain", message: "locked" });
    render(() => <ScopeGroupCard group="live_actions" />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "credential store",
    );
    invoke.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Prismoid could not save that. Try again.",
      ),
    );
  });
});
