// The reply thread open in a pane's thread panel, keyed by the message
// that started it.

import { createSignal } from "solid-js";
import type { ChatMessage } from "./chatStore";

/** The thread a reply belongs to: Twitch names the root, else the parent stands in. */
export function threadRootOf(msg: ChatMessage): string | null {
  return msg.reply_parent?.thread_id || msg.reply_to;
}

export interface ThreadPanel {
  root: () => string | null;
  open: (msg: ChatMessage) => void;
  close: () => void;
}

export function createThreadPanel(): ThreadPanel {
  const [root, setRoot] = createSignal<string | null>(null);
  return {
    root,
    open: (msg) => {
      const r = threadRootOf(msg);
      if (r) setRoot(r);
    },
    close: () => setRoot(null),
  };
}
