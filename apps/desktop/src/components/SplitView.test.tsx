import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Channel } from "../lib/twitchChannel";

const channel = (id: string) =>
  ({ id, login: id, display_name: id.toUpperCase() }) as Channel;
const [tabs, setTabs] = createSignal<Channel[]>([]);
const [active, setActive] = createSignal<Channel | null>(null);
const [status, setStatus] = createSignal("connecting");
const focusChannel = vi.fn(async (id: string) => {
  setActive(tabs().find((c) => c.id === id) ?? null);
});

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => active(),
  channelTabs: () => tabs(),
  channelStatus: () => status(),
  focusChannel: (id: string) => focusChannel(id),
}));
vi.mock("../lib/chatSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatSession")>()),
  holdSession: (c: Channel) => ({ channelId: c.id, channel: c }),
  releaseSession: () => {},
}));
// Each pane's insides are tested on their own; here only which channel a
// pane holds matters.
vi.mock("./ChatFeed", async () => {
  const { useSession } = await import("../lib/chatSession");
  return {
    default: () => (
      <p class="feed-of">{useSession()().channel?.id ?? "none"}</p>
    ),
  };
});
vi.mock("./CommandCenter", () => ({ default: () => null }));
const openVideoWindow = vi.fn<(login: string, title: string) => Promise<void>>(
  async () => {},
);
const [out, setOut] = createSignal<string[]>([]);
let popIn: (login: string) => void = () => {};
const closeVideoWindows = vi.fn(async () => {});
vi.mock("../lib/videoWindow", () => ({
  closeVideoWindows: () => closeVideoWindows(),
  openVideoWindow: (login: string, title: string) =>
    openVideoWindow(login, title),
  isPoppedOut: (login: string) => out().includes(login),
  followVideoWindows: async (onPopIn: (login: string) => void) => {
    popIn = onPopIn;
    return () => {};
  },
}));
vi.mock("./StreamVideo", () => ({
  default: (p: { onPopOut: () => void; onClose: () => void }) => (
    <div>
      <button type="button" onClick={() => p.onPopOut()}>
        pop out
      </button>
      <button type="button" onClick={() => p.onClose()}>
        close video
      </button>
    </div>
  ),
}));
vi.mock("./MessageInput", () => ({ default: () => null }));

let layout: typeof import("../stores/layoutStore");

async function mount() {
  vi.resetModules();
  layout = await import("../stores/layoutStore");
  const { default: SplitView } = await import("./SplitView");
  return render(() => <SplitView login="me" />);
}

const shown = () =>
  [...document.querySelectorAll(".feed-of")].map((e) => e.textContent);

describe("SplitView", () => {
  beforeEach(() => {
    localStorage.clear();
    setTabs([channel("a"), channel("b"), channel("c")]);
    setActive(channel("a"));
    setStatus("ready");
    focusChannel.mockClear();
  });

  afterEach(cleanup);

  it("shows the active tab in one pane, without a pane header", async () => {
    await mount();
    expect(shown()).toEqual(["a"]);
    expect(document.querySelector(".pane-head")).toBeNull();
    setActive(channel("b"));
    expect(shown()).toEqual(["b"]);
  });

  it("splits, follows the focused pane and closes back to one", async () => {
    await mount();
    layout.splitPane("b");
    expect(shown()).toEqual(["a", "b"]);
    expect(focusChannel).toHaveBeenLastCalledWith("b");
    expect(document.querySelectorAll(".pane-head")).toHaveLength(2);

    // Clicking into the first pane makes its channel the active tab.
    fireEvent.pointerDown(document.querySelectorAll(".chat-pane")[0]!);
    expect(focusChannel).toHaveBeenLastCalledWith("a");

    // A tab already in a pane focuses it rather than showing twice.
    setActive(channel("b"));
    expect(shown()).toEqual(["a", "b"]);
    expect(layout.focusedPaneChannel()).toBe("b");

    fireEvent.click(screen.getByRole("button", { name: "Close B's pane" }));
    expect(shown()).toEqual(["a"]);
  });

  it("pops the preview out into a window in its place", async () => {
    await mount();
    const video = () => layout.panes()[0]!.videoChannelId !== null;
    layout.togglePaneVideo(layout.panes()[0]!.id);
    fireEvent.click(screen.getByRole("button", { name: "close video" }));
    expect(video()).toBe(false);
    layout.togglePaneVideo(layout.panes()[0]!.id);
    fireEvent.click(screen.getByRole("button", { name: "pop out" }));
    expect(openVideoWindow).toHaveBeenCalledWith("a", "A's stream");
    expect(video()).toBe(false);
  });

  it("keeps the first channel's stream in the corner after a tab switch", async () => {
    await mount();
    layout.togglePaneVideo(layout.panes()[0]!.id);
    setActive(channel("b"));
    expect(shown()).toEqual(["b"]);
    expect(screen.getByRole("button", { name: "pop out" })).toBeTruthy();
    // Popping it out from b's chat still opens a's stream.
    fireEvent.click(screen.getByRole("button", { name: "pop out" }));
    expect(openVideoWindow).toHaveBeenLastCalledWith("a", "A's stream");
  });

  it("never shows a popped out stream in the corner, and takes it back in", async () => {
    await mount();
    const pane = layout.panes()[0]!.id;
    setOut(["a"]);
    layout.setPaneVideo(pane, true);
    expect(screen.queryByRole("button", { name: "pop out" })).toBeNull();
    layout.setPaneVideo(pane, false);
    // Back to chat from the window: its channel's pane shows the preview
    // once the window is gone.
    popIn("a");
    expect(layout.panes()[0]!.videoChannelId).toBe("a");
    setOut([]);
    expect(screen.getByRole("button", { name: "pop out" })).toBeTruthy();
    popIn("nobody");
    expect(layout.panes()).toHaveLength(1);
  });

  it("takes a dragged tab on a pane or on the right edge", async () => {
    await mount();
    const transfer = {
      types: [layout.TAB_DRAG_TYPE],
      getData: () => "c",
    };
    layout.setDraggedTab("c");
    const edge = document.querySelector(".split__edge")!;
    fireEvent.dragOver(edge, { dataTransfer: transfer });
    fireEvent.drop(edge, { dataTransfer: transfer });
    expect(shown()).toEqual(["a", "c"]);

    const transferB = { types: [layout.TAB_DRAG_TYPE], getData: () => "b" };
    const first = document.querySelectorAll(".split__drop")[0]!;
    fireEvent.dragOver(first, { dataTransfer: transferB });
    fireEvent.drop(first, { dataTransfer: transferB });
    expect(shown()).toEqual(["b", "c"]);
    layout.setDraggedTab(null);
  });

  it("switching a feature off takes its panes, previews and windows", async () => {
    await mount();
    const { updateSettings } = await import("../stores/settingsStore");
    layout.splitPane("b");
    layout.setPaneVideo(layout.panes()[0]!.id, true);
    closeVideoWindows.mockClear();
    await updateSettings({ splitView: false });
    expect(shown()).toEqual(["b"]);
    expect(closeVideoWindows).not.toHaveBeenCalled();
    layout.setPaneVideo(layout.panes()[0]!.id, true);
    await updateSettings({ streamVideo: false });
    expect(layout.panes()[0]!.videoChannelId).toBeNull();
    expect(closeVideoWindows).toHaveBeenCalled();
    await updateSettings({ splitView: true, streamVideo: true });
  });

  it("drops panes whose tab did not come back, once restore is done", async () => {
    localStorage.setItem(
      "prismoid.layout",
      JSON.stringify({
        panes: [
          { id: "p1", channelId: "a" },
          { id: "p2", channelId: "gone" },
        ],
        focused: "p1",
      }),
    );
    setStatus("connecting");
    await mount();
    expect(shown()).toEqual(["a", "none"]);
    setStatus("ready");
    expect(shown()).toEqual(["a"]);
  });
});
