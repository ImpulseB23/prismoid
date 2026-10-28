// Messages Twitch marked as their chatter's first in the channel. The mark
// comes from the sidecar's IRC watcher and can land before or after the
// EventSub copy of the message renders, so lookups track a revision signal.
// Ids are message UUIDs, unique across channels; past the cap the oldest
// go first, and the cap sits well above what the feed buffer ever shows.

import { createSignal } from "solid-js";

/** Payload of the host's `first_message` event. */
export interface FirstMessage {
  channel_id: string;
  message_id: string;
}

export const MAX_FIRST_MESSAGES = 2000;

export interface FirstMessageStore {
  mark: (messageId: string) => void;
  /** Reactive: a caller re-runs when a later mark lands. */
  isFirst: (messageId: string) => boolean;
}

export function createFirstMessageStore(
  max = MAX_FIRST_MESSAGES,
): FirstMessageStore {
  const ids = new Set<string>();
  const [revision, setRevision] = createSignal(0);

  function mark(messageId: string): void {
    if (ids.has(messageId)) return;
    ids.add(messageId);
    if (ids.size > max) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
    setRevision((r) => r + 1);
  }

  return {
    mark,
    isFirst: (messageId) => {
      revision();
      return ids.has(messageId);
    },
  };
}

const defaultStore = createFirstMessageStore();
export const markFirstMessage = defaultStore.mark;
export const isFirstMessage = defaultStore.isFirst;
