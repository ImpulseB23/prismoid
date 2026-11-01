import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Channel } from "../lib/twitchChannel";

const channel = (id: string) =>
  ({ id, login: id, display_name: id.toUpperCase() }) as Channel;
const [tabs, setTabs] = createSignal<Channel[]>([]);
const [active, setActive] = createSignal<Channel | null>(null);
const closeChannel = vi.fn<(id: string) => Promise<void>>(async () => {});
const focusChannel = vi.fn<(id: string) => Promise<void>>(async () => {});
const [previewId, setPreviewId] = createSignal<string | null>(null);
const keepChannel = vi.fn((id: string) => {
  if (previewId() === id) setPreviewId(null);
});

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => active(),
  channelTabs: () => tabs(),
  closeChannel: (id: string) => closeChannel(id),
  focusChannel: (id: string) => focusChannel(id),
  unreadCount: () => 0,
  previewChannelId: () => previewId(),
  keepChannel: (id: string) => keepChannel(id),
  moveChannelTab: (id: string, index: number) => {
    const list = tabs().filter((c) => c.id !== id);
    const moved = tabs().find((c) => c.id === id)!;
    list.splice(index, 0, moved);
    setTabs(list);
  },
}));
const openPicker = vi.fn();
vi.mock("../stores/pickerStore", () => ({
  openPicker: (opts?: unknown) => openPicker(opts),
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

  it("marks the preview tab until a double-click keeps it", async () => {
    setPreviewId("b");
    await mount();
    expect(tab("B").classList.contains("tab--preview")).toBe(true);
    expect(tab("B").title).toContain("Double-click to keep it");
    expect(tab("A").classList.contains("tab--preview")).toBe(false);
    fireEvent.dblClick(tab("B"));
    expect(keepChannel).toHaveBeenCalledWith("b");
    expect(tab("B").classList.contains("tab--preview")).toBe(false);
  });

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

  it("opens the picker for a new pane, until four are open", async () => {
    await mount();
    const button = screen.getByRole("button", {
      name: "Open a channel in a new pane",
    });
    fireEvent.click(button);
    expect(openPicker).toHaveBeenCalledWith({ split: true });
    layout.splitPane("b");
    layout.splitPane("c");
    layout.splitPane("d");
    expect((button as HTMLButtonElement).disabled).toBe(true);
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

  it("moves a tab dropped on another, to the side the pointer is on", async () => {
    setTabs([channel("a"), channel("b"), channel("c")]);
    await mount();
    const order = () => tabs().map((c) => c.id);
    const drag = (id: string) => ({
      types: [layout.TAB_DRAG_TYPE],
      getData: () => id,
    });
    // jsdom has no DragEvent, so the pointer position is set by hand.
    const over = (el: HTMLElement, x: number) => {
      const ev = createEvent.dragOver(el, { dataTransfer: drag("a") });
      Object.defineProperty(ev, "clientX", { value: x });
      fireEvent(el, ev);
    };
    const target = tab("C");
    target.getBoundingClientRect = () => ({ left: 100, width: 100 }) as DOMRect;
    fireEvent.dragStart(tab("A"), { dataTransfer: { setData: () => {} } });
    over(target, 180);
    expect(target.classList.contains("tab--drop-after")).toBe(true);
    fireEvent.drop(target, { dataTransfer: drag("a") });
    expect(order()).toEqual(["b", "c", "a"]);

    const first = tab("B");
    first.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    over(first, 10);
    expect(first.classList.contains("tab--drop-before")).toBe(true);
    fireEvent.drop(first, { dataTransfer: drag("a") });
    expect(order()).toEqual(["a", "b", "c"]);
  });
});
