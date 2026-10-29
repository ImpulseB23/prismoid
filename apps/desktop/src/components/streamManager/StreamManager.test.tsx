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

const { default: StreamManager } = await import("./StreamManager");
const { setAuthStatus } = await import("../../stores/authStore");
const { setStreamManagerOpen, setStreamManagerTab } =
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
    invoke.mockImplementation(async (cmd) =>
      cmd === "twitch_get_ad_schedule"
        ? {
            next_ad_at: null,
            last_ad_at: null,
            duration: 60,
            preroll_free_time: 0,
            snooze_count: 3,
            snooze_refresh_at: null,
          }
        : null,
    );
    await updateSettings({ streamManagerHeight: 0.58 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setStreamManagerOpen(false);
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
