// Who has spoken in the current channel, most recent first, for @mention
// completion. Backed by a Map whose insertion order is recency: a chatter
// who speaks again is deleted and re-inserted so they move to the end.

import type { Chatter } from "../lib/completion";

export interface ChatterStats {
  /** Messages seen from this person since the channel was opened. */
  messages: number;
  /** Arrival time of their first message this session. */
  firstSeen: number;
}

export interface ChatterStore {
  record: (id: string, login: string, displayName: string, at: number) => void;
  byLogin: (login: string) => Chatter | undefined;
  /** Most recent speaker first. */
  recent: () => Chatter[];
  stats: (id: string) => ChatterStats | undefined;
  clear: () => void;
}

export const MAX_CHATTERS = 1000;

export function createChatterStore(max = MAX_CHATTERS): ChatterStore {
  const byLogin = new Map<string, Chatter>();
  const statsById = new Map<string, ChatterStats>();

  function record(
    id: string,
    login: string,
    displayName: string,
    at: number,
  ): void {
    if (!login || !id) return;
    byLogin.delete(login);
    byLogin.set(login, { id, login, display_name: displayName });
    const s = statsById.get(id);
    if (s) s.messages++;
    else statsById.set(id, { messages: 1, firstSeen: at });
    if (byLogin.size > max) {
      const oldest = byLogin.keys().next().value;
      if (oldest !== undefined) {
        const evicted = byLogin.get(oldest);
        byLogin.delete(oldest);
        if (evicted) statsById.delete(evicted.id);
      }
    }
  }

  return {
    record,
    recent: () => [...byLogin.values()].reverse(),
    byLogin: (login) => byLogin.get(login),
    stats: (id) => statsById.get(id),
    clear: () => {
      byLogin.clear();
      statsById.clear();
    },
  };
}

const defaultStore = createChatterStore();
export const recordChatter = defaultStore.record;
export const recentChatters = defaultStore.recent;
export const chatterByLogin = defaultStore.byLogin;
export const chatterStats = defaultStore.stats;
export const clearChatters = defaultStore.clear;
