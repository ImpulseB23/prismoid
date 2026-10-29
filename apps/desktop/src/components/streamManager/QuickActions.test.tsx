import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type { ScopeGroup } from "../../lib/twitchAuth";

type Handler = (args: Record<string, unknown>) => unknown;
const commands = new Map<string, Handler>();
const invoke = vi.fn(
  async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = commands.get(cmd);
    if (!handler) throw new Error(`unexpected ${cmd}`);
    return handler(args);
  },
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));
const openUrl = vi.fn<(url: string) => Promise<void>>(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const { default: QuickActions } = await import("./QuickActions");
const { setAuthStatus } = await import("../../stores/authStore");
const { streamLog, clearStreamLog } =
  await import("../../stores/streamLogStore");

const signIn = (groups: ScopeGroup[]) =>
  setAuthStatus({
    state: "logged_in",
    login: "me",
    user_id: "7",
    missing_scopes: [],
    enabled_scope_groups: groups,
  });

const shield = (is_active: boolean) => ({
  is_active,
  moderator_id: "",
  moderator_login: "",
  moderator_name: "",
  last_activated_at: null,
});

describe("QuickActions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    commands.clear();
    clearStreamLog();
    setAuthStatus(null);
  });

  it("offers markers and explains the opt-in actions", () => {
    signIn([]);
    render(() => <QuickActions live={false} />);
    const marker = screen.getByRole<HTMLButtonElement>("button", {
      name: /Add marker/,
    });
    expect(marker.disabled).toBe(true);
    expect(marker.textContent).toContain("When you are live");
    expect(screen.queryByRole("button", { name: /Clip that/ })).toBeNull();
    expect(screen.getByText("Clips, shoutouts and more")).toBeTruthy();
  });

  it("adds a marker to the timeline", async () => {
    signIn([]);
    commands.set("twitch_create_marker", () => ({
      id: "m1",
      created_at: 5,
      position_seconds: 3753,
      description: "",
    }));
    render(() => <QuickActions live />);
    fireEvent.click(screen.getByRole("button", { name: /Add marker/ }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Marker added at 1:02:33.",
    );
    expect(streamLog().map((e) => e.id)).toEqual(["m1"]);

    commands.set("twitch_create_marker", () => {
      throw { kind: "marker_unavailable", message: "" };
    });
    fireEvent.click(screen.getByRole("button", { name: /Add marker/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Markers need a live stream",
    );
  });

  it("switches Shield Mode", async () => {
    signIn(["live_actions"]);
    commands.set("twitch_get_shield_mode", () => shield(false));
    commands.set("twitch_set_shield_mode", (a) => shield(a.isActive === true));
    render(() => <QuickActions live={false} />);
    const tile = () => screen.getByRole("button", { name: /Shield Mode/ });
    await waitFor(() =>
      expect(tile().getAttribute("aria-pressed")).toBe("false"),
    );
    fireEvent.click(tile());
    await waitFor(() =>
      expect(tile().getAttribute("aria-pressed")).toBe("true"),
    );
    expect(tile().textContent).toContain("On. Tap to lift it");
  });

  it("makes a clip and links to its editor", async () => {
    vi.useFakeTimers();
    signIn(["live_actions"]);
    commands.set("twitch_get_shield_mode", () => shield(false));
    commands.set("twitch_create_clip", () => ({
      id: "c1",
      edit_url: "https://www.twitch.tv/me/clip/c1",
    }));
    let made = false;
    commands.set("twitch_get_clip", () => (made ? { id: "c1" } : null));
    render(() => <QuickActions live />);
    fireEvent.click(screen.getByRole("button", { name: /Clip that/ }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("Making your clip")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText("Making your clip")).toBeTruthy();
    made = true;
    await vi.advanceTimersByTimeAsync(5000);
    fireEvent.click(
      screen.getByRole("button", { name: "Trim and title it on Twitch" }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://www.twitch.tv/me/clip/c1");
  });

  it("gives up on a clip Twitch never finishes", async () => {
    vi.useFakeTimers();
    signIn(["live_actions"]);
    commands.set("twitch_get_shield_mode", () => shield(false));
    commands.set("twitch_create_clip", () => ({ id: "c1", edit_url: "u" }));
    commands.set("twitch_get_clip", () => null);
    render(() => <QuickActions live />);
    fireEvent.click(screen.getByRole("button", { name: /Clip that/ }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(screen.getByRole("alert").textContent).toContain(
      "Twitch could not finish that clip",
    );
  });

  it("sends a shoutout by channel name", async () => {
    signIn(["live_actions"]);
    commands.set("twitch_get_shield_mode", () => shield(false));
    commands.set("twitch_lookup_user", () => ({
      id: "9",
      login: "mira_tv",
      display_name: "Mira_TV",
      profile_image_url: "",
    }));
    commands.set("twitch_send_shoutout", () => undefined);
    render(() => <QuickActions live />);
    fireEvent.click(screen.getByRole("button", { name: /Shoutout/ }));
    const name = screen.getByLabelText("Channel to shout out");
    fireEvent.input(name, { target: { value: "bad name!" } });
    fireEvent.click(screen.getByRole("button", { name: "Send shoutout" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a Twitch username",
    );
    fireEvent.input(name, { target: { value: "@Mira_TV" } });
    fireEvent.click(screen.getByRole("button", { name: "Send shoutout" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Shoutout sent to Mira_TV.",
    );
    expect(invoke).toHaveBeenCalledWith("twitch_lookup_user", {
      login: "mira_tv",
    });
    expect(invoke).toHaveBeenCalledWith("twitch_send_shoutout", {
      toBroadcasterId: "9",
    });
    expect(screen.queryByLabelText("Channel to shout out")).toBeNull();
  });

  it("sends an announcement in a color", async () => {
    signIn(["live_actions"]);
    commands.set("twitch_get_shield_mode", () => shield(false));
    commands.set("twitch_send_announcement", () => {
      throw { kind: "helix", status: 429, message: "" };
    });
    render(() => <QuickActions live={false} />);
    const tile = screen.getByRole("button", { name: /Announce/ });
    fireEvent.click(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    fireEvent.input(screen.getByLabelText(/^Announcement/), {
      target: { value: "raid in 5" },
    });
    fireEvent.change(screen.getByLabelText("Color"), {
      target: { value: "blue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send announcement" }));
    expect((await screen.findByRole("alert")).textContent).toContain("429");

    commands.set("twitch_send_announcement", () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Send announcement" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Announcement sent.",
    );
    expect(invoke).toHaveBeenCalledWith("twitch_send_announcement", {
      message: "raid in 5",
      color: "blue",
    });
  });
});
