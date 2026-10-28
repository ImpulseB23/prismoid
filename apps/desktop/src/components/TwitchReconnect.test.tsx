import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { AuthStatus, LoginView } from "../lib/twitchAuth";

const startLogin = vi.fn<() => Promise<LoginView>>();
const completeLogin = vi.fn<() => Promise<AuthStatus>>();
const cancelLogin = vi.fn(async () => {});
const openTwitchUrl = vi.fn<(url: string) => Promise<void>>(async () => {});
vi.mock("../lib/twitchAuth", () => ({
  startLogin: () => startLogin(),
  completeLogin: () => completeLogin(),
  cancelLogin: () => cancelLogin(),
  openTwitchUrl: (url: string) => openTwitchUrl(url),
}));

const { default: TwitchReconnect } = await import("./TwitchReconnect");
const { authStatus, setAuthStatus } = await import("../stores/authStore");

const view = { authorize_url: "https://id.twitch.tv/oauth2/authorize?x" };
const status: AuthStatus = {
  state: "logged_in",
  login: "me",
  user_id: "1",
  missing_scopes: [],
  enabled_scope_groups: [],
};

const show = () =>
  render(() => <TwitchReconnect title="Needs access" hint="Reconnect once." />);

describe("TwitchReconnect", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    setAuthStatus(null);
  });

  it("opens Twitch and takes the new grant", async () => {
    startLogin.mockResolvedValueOnce(view);
    let finish!: (s: AuthStatus) => void;
    completeLogin.mockReturnValueOnce(new Promise((r) => (finish = r)));
    show();
    expect(screen.getByText("Needs access")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Twitch" }));
    await vi.waitFor(() => expect(openTwitchUrl).toHaveBeenCalledOnce());
    expect(openTwitchUrl).toHaveBeenCalledWith(view.authorize_url);
    fireEvent.click(screen.getByText("Open it again"));
    expect(openTwitchUrl).toHaveBeenCalledTimes(2);
    finish(status);
    await vi.waitFor(() => expect(authStatus()).toEqual(status));
    expect(
      screen.getByRole("button", { name: "Reconnect Twitch" }),
    ).toBeTruthy();
  });

  it("cancels a pending sign-in", async () => {
    startLogin.mockResolvedValueOnce(view);
    completeLogin.mockReturnValueOnce(new Promise(() => {}));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Twitch" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Reconnect Twitch" }),
    ).toBeTruthy();
  });

  it("says why it failed", async () => {
    startLogin.mockRejectedValueOnce({ kind: "user_denied", message: "" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Twitch" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Authorization was declined",
    );
  });

  it("gives the link when the browser does not open", async () => {
    startLogin.mockResolvedValueOnce(view);
    completeLogin.mockReturnValueOnce(new Promise(() => {}));
    openTwitchUrl.mockRejectedValueOnce(new Error("no browser"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Twitch" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      view.authorize_url,
    );
  });
});
