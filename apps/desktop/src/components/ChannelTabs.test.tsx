import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Channel } from "../lib/twitchChannel";

const channel = (id: string) =>
  ({ id, login: id, display_name: id.toUpperCase() }) as Channel;
const [tabs, setTabs] = createSignal<Channel[]>([]);
const [active, setActive] = createSignal<Channel | null>(null);
const closeChannel = vi.fn<(id: string) => Promise<void>>(async () => {});
const focusChannel = vi.fn<(id: string) => Promise<void>>(async () => {});

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => active(),
  channelTabs: () => tabs(),
  closeChannel: (id: string) => closeChannel(id),
  focusChannel: (id: string) => focusChannel(id),
  unreadCount: () => 0,
}));
vi.mock("../stores/pickerStore", () => ({
  openPicker: () => {},
  pickerLoading: () => false,
  prefetchLive: async () => {},
}));

let layout: typeof import("../stores/layoutStore");
let menu: typeof import("../stores/contextMenuStore");

async function mount() {
  vi.resetModules();
  layout = await import("../stores/layoutStore");
  menu = await import("../stores/contextMenuStore");
  const { default: ChannelTabs } = await import("./ChannelTabs");
  render(() => <ChannelTabs />);
  layout.showInFocusedPane("a");
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("ChannelTabs", () => {
  beforeEach(() => {
    localStorage.clear();
    setTabs([channel("a"), channel("b")]);
    setActive(channel("a"));
    closeChannel.mockClear();
  });

  afterEach(cleanup);

  it("opens a tab in a split from its menu, once", async () => {
    await mount();
    fireEvent.contextMenu(tab("B"));
    const split = menu.contextMenu()!.items[0]!;
    expect(split).toMatchObject({ label: "Open in split" });
    if (split.kind === "item") split.onSelect();
    expect(layout.panes().map((p) => p.channelId)).toEqual(["a", "b"]);
    // Shown in a pane that is not the focused one, it is marked as such and
    // its menu no longer offers a split.
    setActive(channel("a"));
    layout.focusPaneSlot(layout.panes()[0]!.id);
    expect(tab("B").classList.contains("tab--shown")).toBe(true);
    menu.closeContextMenu();
    fireEvent.contextMenu(tab("B"));
    expect(menu.contextMenu()).toBeNull();
  });

  it("hands its channel to the panes while dragged", async () => {
    await mount();
    const setData = vi.fn();
    fireEvent.dragStart(tab("B"), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(layout.TAB_DRAG_TYPE, "b");
    expect(layout.draggedTab()).toBe("b");
    fireEvent.dragEnd(tab("B"));
    expect(layout.draggedTab()).toBeNull();
  });

  it("closes the pane of a closed tab before the tab", async () => {
    await mount();
    layout.splitPane("b");
    fireEvent.click(screen.getByRole("button", { name: "Close B" }));
    expect(layout.panes().map((p) => p.channelId)).toEqual(["a"]);
    expect(closeChannel).toHaveBeenCalledWith("b");
  });
});
