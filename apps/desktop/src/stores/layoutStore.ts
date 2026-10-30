// Which channel each chat pane shows, side by side, and which pane is
// focused. A channel shows in at most one pane: asking for one that is
// already on screen focuses its pane instead. The layout is saved, so the
// panes come back after a restart once their tabs have.

import { createSignal } from "solid-js";
import type { StorageLike } from "./channelStore";
import { settings } from "./settingsStore";

export const MAX_PANES = 4;
const KEY = "prismoid.layout";

/** Carries a tab's channel id while it is dragged onto the panes. */
export const TAB_DRAG_TYPE = "application/x-prismoid-channel";

export interface PaneSlot {
  id: string;
  /** Null until the pane has a channel, e.g. before any tab is open. */
  channelId: string | null;
  /**
   * The channel whose stream plays in this pane's corner. It stays when the
   * pane switches to another tab, so a stream keeps playing while you read
   * another chat.
   */
  videoChannelId: string | null;
}

interface Saved {
  panes: PaneSlot[];
  focused: string;
}

export interface LayoutStore {
  panes: () => PaneSlot[];
  focusedId: () => string;
  /** The focused pane's channel, which the rest of the window follows. */
  focusedChannel: () => string | null;
  focus: (paneId: string) => void;
  /**
   * Shows `channelId` in the focused pane, or focuses the pane already
   * showing it.
   */
  show: (channelId: string) => void;
  /** Shows `channelId` in `paneId`, or focuses the pane already showing it. */
  showIn: (paneId: string, channelId: string) => void;
  /**
   * Opens `channelId` in a new pane right of `afterId` (the focused one by
   * default) and focuses it. False when it is already on screen, which
   * focuses its pane, or when there is no room for another pane.
   */
  split: (channelId: string, afterId?: string) => boolean;
  canSplit: () => boolean;
  /** Closes a pane; the last one never closes. */
  close: (paneId: string) => void;
  /** A tab closed: its pane goes, or empties if it is the last one. */
  drop: (channelId: string) => void;
  /** Drops panes whose channel is no longer open. */
  keepOnly: (channelIds: ReadonlySet<string>) => void;
  /**
   * The video button: plays the pane's own channel in its corner, or hides
   * it when that is what already plays there.
   */
  toggleVideo: (paneId: string) => void;
  /** Plays the pane's own channel in its corner, or hides the corner. */
  setVideo: (paneId: string, on: boolean) => void;
  /** Back to the focused pane alone, for when split view is switched off. */
  collapse: () => void;
  /** Hides the video in every pane, for when stream video is switched off. */
  clearVideo: () => void;
}

/** Whether the split view and stream video features are switched on. */
export interface LayoutFeatures {
  split: () => boolean;
  video: () => boolean;
}

export function createLayoutStore(
  storage: StorageLike | null = defaultStorage(),
  features: LayoutFeatures = { split: () => true, video: () => true },
): LayoutStore {
  const saved = read(storage);
  let nextId = 0;
  const newId = () => {
    let id: string;
    do id = `pane-${++nextId}`;
    while (panes().some((p) => p.id === id));
    return id;
  };
  const [panes, setPanes] = createSignal<PaneSlot[]>(
    saved?.panes ?? [{ id: "pane-0", channelId: null, videoChannelId: null }],
  );
  const [focusedId, setFocusedId] = createSignal(
    saved?.focused ?? panes()[0]!.id,
  );

  const save = () => {
    try {
      storage?.setItem(
        KEY,
        JSON.stringify({ panes: panes(), focused: focusedId() }),
      );
    } catch {
      // best-effort persistence
    }
  };
  const update = (next: PaneSlot[], focused = focusedId()) => {
    setPanes(next);
    setFocusedId(next.some((p) => p.id === focused) ? focused : next[0]!.id);
    save();
  };
  const paneShowing = (channelId: string) =>
    panes().find((p) => p.channelId === channelId);

  function focus(paneId: string): void {
    if (paneId === focusedId() || !panes().some((p) => p.id === paneId)) {
      return;
    }
    setFocusedId(paneId);
    save();
  }

  function showIn(paneId: string, channelId: string): void {
    const shown = paneShowing(channelId);
    if (shown) {
      focus(shown.id);
      return;
    }
    update(
      panes().map((p) => (p.id === paneId ? { ...p, channelId } : p)),
      paneId,
    );
  }

  function split(channelId: string, afterId = focusedId()): boolean {
    const shown = paneShowing(channelId);
    if (shown) {
      focus(shown.id);
      return false;
    }
    if (!features.split() || panes().length >= MAX_PANES) return false;
    const at = panes().findIndex((p) => p.id === afterId);
    const pane = { id: newId(), channelId, videoChannelId: null };
    const next = [...panes()];
    next.splice(at < 0 ? next.length : at + 1, 0, pane);
    update(next, pane.id);
    return true;
  }

  function close(paneId: string): void {
    const list = panes();
    if (list.length < 2) return;
    const at = list.findIndex((p) => p.id === paneId);
    if (at < 0) return;
    const next = list.filter((p) => p.id !== paneId);
    // Focus moves to the neighbour on the left, as closing a tab does.
    const focused =
      paneId === focusedId() ? next[Math.max(0, at - 1)]!.id : focusedId();
    update(next, focused);
  }

  // A closed tab's stream stops wherever it plays.
  function stopVideoOf(gone: (channelId: string) => boolean): void {
    if (panes().some((p) => p.videoChannelId && gone(p.videoChannelId))) {
      update(
        panes().map((p) =>
          p.videoChannelId && gone(p.videoChannelId)
            ? { ...p, videoChannelId: null }
            : p,
        ),
      );
    }
  }

  function drop(channelId: string): void {
    stopVideoOf((id) => id === channelId);
    const pane = paneShowing(channelId);
    if (!pane) return;
    if (panes().length > 1) close(pane.id);
    else update([{ ...pane, channelId: null }]);
  }

  function keepOnly(channelIds: ReadonlySet<string>): void {
    stopVideoOf((id) => !channelIds.has(id));
    for (const p of panes()) {
      if (p.channelId !== null && !channelIds.has(p.channelId)) {
        drop(p.channelId);
      }
    }
  }

  function setVideo(paneId: string, on: boolean): void {
    if (on && !features.video()) return;
    update(
      panes().map((p) =>
        p.id === paneId ? { ...p, videoChannelId: on ? p.channelId : null } : p,
      ),
    );
  }

  function toggleVideo(paneId: string): void {
    const pane = panes().find((p) => p.id === paneId);
    if (!pane?.channelId) return;
    setVideo(paneId, pane.videoChannelId !== pane.channelId);
  }

  return {
    panes,
    focusedId,
    focusedChannel: () =>
      panes().find((p) => p.id === focusedId())?.channelId ?? null,
    focus,
    show: (channelId) => showIn(focusedId(), channelId),
    showIn,
    split,
    canSplit: () => features.split() && panes().length < MAX_PANES,
    close,
    drop,
    keepOnly,
    toggleVideo,
    setVideo,
    collapse: () => {
      const focused = panes().find((p) => p.id === focusedId());
      if (panes().length > 1 && focused) update([focused]);
    },
    clearVideo: () => stopVideoOf(() => true),
  };
}

function read(storage: StorageLike | null): Saved | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    const panes = Array.isArray(parsed.panes)
      ? parsed.panes.flatMap((p: unknown) => {
          const slot = readSlot(p);
          return slot ? [slot] : [];
        })
      : [];
    if (panes.length === 0) return null;
    const kept = panes.slice(0, MAX_PANES);
    const focused =
      typeof parsed.focused === "string" &&
      kept.some((p) => p.id === parsed.focused)
        ? parsed.focused
        : kept[0]!.id;
    return { panes: kept, focused };
  } catch {
    return null;
  }
}

function readSlot(raw: unknown): PaneSlot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string") return null;
  if (p.channelId !== null && typeof p.channelId !== "string") return null;
  const channelId = p.channelId;
  // Layouts saved before the corner followed its channel kept a flag.
  const videoChannelId =
    typeof p.videoChannelId === "string"
      ? p.videoChannelId
      : p.video === true
        ? channelId
        : null;
  return { id: p.id, channelId, videoChannelId };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const [draggedTab, setDraggedTab] = createSignal<string | null>(null);

/** The channel of the tab being dragged, so panes can show drop targets. */
export { draggedTab, setDraggedTab };

const defaultStore = createLayoutStore(defaultStorage(), {
  split: () => settings().splitView,
  video: () => settings().streamVideo,
});
export const panes = defaultStore.panes;
export const focusedPaneId = defaultStore.focusedId;
export const focusedPaneChannel = defaultStore.focusedChannel;
export const focusPaneSlot = defaultStore.focus;
export const showInPane = defaultStore.showIn;
export const showInFocusedPane = defaultStore.show;
export const splitPane = defaultStore.split;
export const canSplitPane = defaultStore.canSplit;
export const closePane = defaultStore.close;
export const dropPaneChannel = defaultStore.drop;
export const keepPaneChannels = defaultStore.keepOnly;
export const togglePaneVideo = defaultStore.toggleVideo;
export const setPaneVideo = defaultStore.setVideo;
export const collapsePanes = defaultStore.collapse;
export const clearPaneVideo = defaultStore.clearVideo;
