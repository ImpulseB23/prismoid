import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

vi.mock("../stores/streamStore", () => ({
  streamLoading: () => false,
  streamClock: () => 0,
  streamInfo: () => ({
    is_live: true,
    title: "Finals",
    game_name: "Counter-Strike",
    viewer_count: 28000,
    started_at: null,
  }),
}));
vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: "c", login: "c", display_name: "C" }),
}));
const popped = { out: false };
const openVideoWindow = vi.fn<(login: string, title: string) => Promise<void>>(
  async () => {},
);
vi.mock("../lib/videoWindow", () => ({
  isPoppedOut: () => popped.out,
  openVideoWindow: (login: string, title: string) =>
    openVideoWindow(login, title),
}));
vi.mock("../stores/pulseStore", () => ({
  startPulse: () => () => {},
  messagesPerMinute: () => 0,
  activeChatters: () => 0,
}));

const { default: StreamBar } = await import("./StreamBar");
const layout = await import("../stores/layoutStore");
const { updateSettings } = await import("../stores/settingsStore");

describe("StreamBar", () => {
  afterEach(() => {
    cleanup();
    popped.out = false;
  });

  it("shows and hides the stream in the focused pane", () => {
    layout.showInFocusedPane("c");
    render(() => <StreamBar />);
    const focused = () =>
      layout.panes().find((p) => p.id === layout.focusedPaneId());
    fireEvent.click(screen.getByRole("button", { name: "Watch the stream" }));
    expect(focused()?.videoChannelId).toBe("c");
    const hide = screen.getByRole("button", { name: "Hide the stream" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(focused()?.videoChannelId).toBeNull();
  });

  it("has no video button while stream video is off", async () => {
    await updateSettings({ streamVideo: false });
    render(() => <StreamBar />);
    expect(
      screen.queryByRole("button", { name: "Watch the stream" }),
    ).toBeNull();
    await updateSettings({ streamVideo: true });
  });

  it("brings a popped out stream's window forward instead of a second player", () => {
    popped.out = true;
    render(() => <StreamBar />);
    const focused = () =>
      layout.panes().find((p) => p.id === layout.focusedPaneId());
    fireEvent.click(
      screen.getByRole("button", { name: "Watching in its own window" }),
    );
    expect(openVideoWindow).toHaveBeenCalledWith("c", "C's stream");
    expect(focused()?.videoChannelId).toBeFalsy();
  });
});
