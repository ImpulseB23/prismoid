// Stored chat tail. Mirrors apps/desktop/src-tauri/src/chat_history.rs.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "../stores/chatStore";

/** Rows asked for when a channel opens. */
export const HISTORY_TAIL = 1000;

export function loadHistory(
  channelId: string,
  limit = HISTORY_TAIL,
): Promise<ChatMessage[]> {
  return invoke("chat_history", { channelId, limit });
}

/**
 * Puts the stored tail ahead of live messages. The feed empties on a
 * channel switch and asks for history; batches that land while that load
 * is in flight wait here, then follow the stored rows minus any message
 * that arrived both ways. A load that resolves after the next `begin`
 * belongs to a channel no longer shown and is dropped.
 */
export function createHistoryGate(add: (batch: ChatMessage[]) => void) {
  let pending: { queued: ChatMessage[] } | null = null;
  const [loading, setLoading] = createSignal(false);

  return {
    /** True while a load is in flight, for the feed's loading state. */
    loading,
    begin(load: Promise<ChatMessage[]>): void {
      const mine = { queued: [] as ChatMessage[] };
      pending = mine;
      setLoading(true);
      const release = (stored: ChatMessage[]) => {
        if (pending !== mine) return;
        pending = null;
        setLoading(false);
        const live = new Set(mine.queued.map((m) => m.id));
        add(stored.filter((m) => !live.has(m.id)));
        add(mine.queued);
      };
      load.then(release, (err: unknown) => {
        console.error("failed to load chat history:", err);
        release([]);
      });
    },
    /** True when the batch was held back for a load in flight. */
    offer(batch: ChatMessage[]): boolean {
      if (!pending) return false;
      pending.queued.push(...batch);
      return true;
    },
    cancel(): void {
      pending = null;
      setLoading(false);
    },
  };
}
