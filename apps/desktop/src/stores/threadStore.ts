// The reply thread open in the thread panel, keyed by the message that
// started it.

import { createSignal } from "solid-js";
import type { ChatMessage } from "./chatStore";

const [threadRoot, setThreadRoot] = createSignal<string | null>(null);

/** The thread a reply belongs to: Twitch names the root, else the parent stands in. */
export function threadRootOf(msg: ChatMessage): string | null {
  return msg.reply_parent?.thread_id || msg.reply_to;
}

export function openThread(msg: ChatMessage): void {
  const root = threadRootOf(msg);
  if (root) setThreadRoot(root);
}

export const closeThread = () => setThreadRoot(null);

export { threadRoot };
