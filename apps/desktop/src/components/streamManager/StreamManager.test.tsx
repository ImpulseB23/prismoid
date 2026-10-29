import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type { AuthStatus } from "../../lib/twitchAuth";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
const openUrl = vi.fn<(url: string) => Promise<void>>(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const { default: StreamManager } = await import("./StreamManager");
const { AFFILIATE_GUIDE } = await import("./AffiliateGate");
const { setAuthStatus } = await import("../../stores/authStore");
const { ownChannelMonetized, setStreamManagerOpen, setStreamManagerTab } =
  await import("../../stores/streamManagerPanelStore");
const { settings, updateSettings } = await import("../../stores/settingsStore");

const signIn = (over: Partial<AuthStatus> = {}) =>
  setAuthStatus({
    state: "logged_in",
    login: "me",
    user_id: "7",
    missing_scopes: [],
    enabled_scope_groups: [],
    ...over,
  } as AuthStatus);

const curtain = () => screen.queryByRole("region", { name: "Stream manager" });
const handle = () =>
  screen.getByRole("separator", { name: "Resize stream manager" });

describe("StreamManager", () => {
  beforeAll(() => {
    // jsdom has no pointer capture.
    const captured = new Set<number>();
    Element.prototype.setPointerCapture = (id: number) => captured.add(id);
    Element.prototype.releasePointerCapture = (id: number) =>
      captured.delete(id);
    Element.prototype.hasPointerCapture = (id: number) => captured.has(id);
  });

  beforeEach(async () => {
    // User 8 is neither Affiliate nor Partner; everyone else is an Affiliate.
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "twitch_users_info") {
        return (args as { ids: string[] }).ids.map((id) => ({
          id,
          login: `u${id}`,
          display_name: `U${id}`,
          profile_image_url: "",
          description: "",
          created_at: "",
          broadcaster_type: id === "8" ? "" : "affiliate",
        }));
      }
      return cmd === "twitch_get_ad_schedule"
        ? {
            next_ad_at: null,
            last_ad_at: null,
            duration: 60,
            preroll_free_time: 0,
            snooze_count: 3,
            snooze_refresh_at: null,
          }
        : null;
    });
    await updateSettings({ streamManagerHeight: 0.58 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setStreamManagerOpen(false);
    setStreamManagerTab("live");
    setAuthStatus(null);
  });

  it("loads on first open and rolls up on Escape", async () => {
    signIn();
    render(() => <StreamManager />);
    expect(curtain()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "twitch_get_channel_info",
      undefined,
    );

    setStreamManagerOpen(true);
    expect(curtain()).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Live" }).ariaSelected).toBe("true");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("twitch_get_channel_info", undefined),
    );
    expect(invoke).toHaveBeenCalledWith("twitch_get_stream_info", {
      channelId: "7",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "twitch_get_ad_schedule",
      undefined,
    );

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(curtain()!.classList.contains("sm-curtain--closing")).toBe(false);
    dialog.remove();

    fireEvent.keyDown(document.body, { key: "Escape" });
    const section = curtain()!;
    expect(section.classList.contains("sm-curtain--closing")).toBe(true);
    fireEvent.animationEnd(section);
    expect(curtain()).toBeNull();
  });

  it("tracks ads only while open with ads on", async () => {
    signIn({ enabled_scope_groups: ["ads"] });
    render(() => <StreamManager />);
    expect(invoke).not.toHaveBeenCalledWith(
      "twitch_get_ad_schedule",
      undefined,
    );
    setStreamManagerOpen(true);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("twitch_get_ad_schedule", undefined),
    );
  });

  it("leaves ads alone for a channel that cannot run them", async () => {
    signIn({ user_id: "8", enabled_scope_groups: ["ads"] });
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("twitch_users_info", { ids: ["8"] }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "twitch_get_ad_schedule",
      undefined,
    );
  });

  it("greys out ads and polls with the reason for a channel that cannot use them", async () => {
    signIn({ user_id: "8" });
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    setStreamManagerTab("ads");
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain(
      "Ads are for Twitch Affiliates and Partners.",
    );
    expect((note.nextElementSibling as HTMLElement).inert).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "How to reach Affiliate" }),
    );
    expect(openUrl).toHaveBeenCalledWith(AFFILIATE_GUIDE);
    setStreamManagerTab("polls");
    expect((await screen.findByRole("note")).textContent).toContain(
      "Polls and predictions are for Twitch Affiliates and Partners.",
    );
  });

  it("keeps ads and polls usable for an affiliate", async () => {
    signIn();
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    setStreamManagerTab("ads");
    await waitFor(() => expect(ownChannelMonetized()).toBe(true));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("rolls up on a click outside, but not inside or on its button", () => {
    signIn();
    render(() => (
      <>
        <button type="button" data-stream-manager-toggle>
          toggle
        </button>
        <p>chat</p>
        <StreamManager />
      </>
    ));
    setStreamManagerOpen(true);
    fireEvent.pointerDown(curtain()!);
    fireEvent.pointerDown(screen.getByText("toggle"));
    expect(curtain()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText("chat"));
    expect(curtain()?.classList.contains("sm-curtain--closing")).toBe(true);
  });

  it("resizes with the keyboard and by dragging, and remembers it", () => {
    signIn();
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    expect(handle().getAttribute("aria-valuenow")).toBe("58");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(handle().getAttribute("aria-valuenow")).toBe("63");
    expect(settings().streamManagerHeight).toBeCloseTo(0.63);
    fireEvent.keyDown(handle(), { key: "End" });
    expect(handle().getAttribute("aria-valuenow")).toBe("85");
    fireEvent.keyDown(handle(), { key: "Home" });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(handle().getAttribute("aria-valuenow")).toBe("35");

    const frame = document.querySelector<HTMLElement>(".sm-curtain-frame")!;
    frame.parentElement!.getBoundingClientRect = () =>
      ({ top: 100, height: 400 }) as DOMRect;
    fireEvent.pointerDown(handle(), { pointerId: 1 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 380 });
    expect(frame.style.height).toBe("70%");
    expect(settings().streamManagerHeight).toBeCloseTo(0.35);
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(settings().streamManagerHeight).toBeCloseTo(0.7);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 120 });
    expect(frame.style.height).toBe("70%");
  });

  it("moves between tabs with the keyboard", () => {
    signIn();
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    const tab = (name: string) => screen.getByRole("tab", { name });
    fireEvent.keyDown(tab("Live"), { key: "ArrowRight" });
    expect(tab("Ads").ariaSelected).toBe("true");
    expect(document.activeElement).toBe(tab("Ads"));
    expect(screen.getByRole("tabpanel").id).toBe("sm-panel-ads");
    fireEvent.keyDown(tab("Ads"), { key: "End" });
    expect(tab("Polls and predictions").ariaSelected).toBe("true");
    expect(screen.getByText("Start a poll")).toBeTruthy();
    fireEvent.keyDown(tab("Polls and predictions"), { key: "ArrowRight" });
    expect(tab("Live").ariaSelected).toBe("true");
    fireEvent.keyDown(tab("Live"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab("Polls and predictions"), { key: "Home" });
    fireEvent.keyDown(tab("Live"), { key: "Tab" });
    expect(tab("Live").ariaSelected).toBe("true");
    fireEvent.click(tab("Ads"));
    expect(screen.getByText("Run your ads from here")).toBeTruthy();
    setStreamManagerTab("live");
  });

  it("asks for a reconnect when the grant predates it", () => {
    signIn({ missing_scopes: ["channel:manage:broadcast"] });
    render(() => <StreamManager />);
    setStreamManagerOpen(true);
    expect(
      screen.getByText("The stream manager needs a new Twitch permission"),
    ).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith(
      "twitch_get_channel_info",
      undefined,
    );
  });
});
