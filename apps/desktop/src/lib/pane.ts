// What belongs to one chat pane rather than its channel: the composer, the
// thread panel and the notice line. The focused pane is the layout's
// focused slot; requests from outside any pane (a user card's Mention) go
// to it.

import { createContext, createSignal, useContext } from "solid-js";
import { focusedPaneId } from "../stores/layoutStore";
import type { ChatSession } from "./chatSession";
import type { Composer } from "../stores/composerStore";
import type { ThreadPanel } from "../stores/threadStore";
import type { NoticeLine } from "../stores/noticeStore";

export interface Pane {
  session: () => ChatSession;
  composer: Composer;
  thread: ThreadPanel;
  notice: NoticeLine;
}

const PaneContext = createContext<Pane>();

export const PaneProvider = PaneContext.Provider;

/** The pane this component is in, if any; user card windows have none. */
export function usePane(): Pane | undefined {
  return useContext(PaneContext);
}

/** For components that only ever render inside a pane. */
export function requirePane(): Pane {
  const pane = useContext(PaneContext);
  if (!pane) throw new Error("rendered outside a chat pane");
  return pane;
}

const [mounted, setMounted] = createSignal<ReadonlyMap<string, Pane>>(
  new Map(),
);

/** Called by each mounted pane for its layout slot; returns the unmount. */
export function registerPane(slotId: string, pane: Pane): () => void {
  setMounted((m) => new Map(m).set(slotId, pane));
  return () =>
    setMounted((m) => {
      if (m.get(slotId) !== pane) return m;
      const next = new Map(m);
      next.delete(slotId);
      return next;
    });
}

export function focusedPane(): Pane | undefined {
  return mounted().get(focusedPaneId());
}
