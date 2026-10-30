// What belongs to one chat pane rather than its channel: the composer, the
// thread panel and the notice line. Panes on the same channel share a
// session but never these. The focused pane is the last one clicked or
// typed in; requests from outside any pane (a user card's Mention) go to it.

import { createContext, createSignal, useContext } from "solid-js";
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

const [focusedPane, setFocused] = createSignal<Pane | null>(null);

export { focusedPane };

export function focusPane(pane: Pane): void {
  setFocused(pane);
}

/** A closing pane hands focus back only if it held it. */
export function blurPane(pane: Pane): void {
  if (focusedPane() === pane) setFocused(null);
}
