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
