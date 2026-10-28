// Chat pulse per open channel: messages in the last minute and distinct
// chatters in the last five, counted exactly from live arrival times rather
// than estimated. Every tab counts in the background, so switching to one
// shows its real numbers straight away. A one-second tick re-reads the open
// channel so the numbers fall as messages age out even when chat goes quiet.
// Backlog and history rows never pass through here, so they cannot inflate
// the count.

import { createSignal } from "solid-js";

export const RATE_WINDOW_MS = 60_000;
export const ACTIVE_WINDOW_MS = 5 * 60_000;
const TICK_MS = 1000;

interface ChannelPulse {
  // Arrival times, oldest first; `head` skips the ones that aged out so the
  // array is only compacted now and then.
  times: number[];
  head: number;
  // Insertion order is recency: a returning chatter is moved to the end, so
  // the stale ones are always at the front.
  lastSeen: Map<string, number>;
}

export interface PulseStore {
  record: (channelId: string, userId: string, at: number) => void;
  /** Messages that arrived in the channel in the last minute. */
  perMinute: (channelId: string) => number;
  /** Distinct people who chatted in the channel in the last five minutes. */
  activeChatters: (channelId: string) => number;
  /** Drops every channel not in `channelIds`, e.g. closed tabs. */
  retain: (channelIds: Iterable<string>) => void;
  /** Starts the one-second tick; returns a stop function. */
  start: () => () => void;
}

function prune(p: ChannelPulse, t: number): void {
  while (
    p.head < p.times.length &&
    (p.times[p.head] ?? 0) <= t - RATE_WINDOW_MS
  ) {
    p.head++;
  }
  if (p.head > 1024 && p.head * 2 > p.times.length) {
    p.times = p.times.slice(p.head);
    p.head = 0;
  }
  for (const [id, at] of p.lastSeen) {
    if (at > t - ACTIVE_WINDOW_MS) break;
    p.lastSeen.delete(id);
  }
}

export function createPulseStore(now: () => number = Date.now): PulseStore {
  const channels = new Map<string, ChannelPulse>();
  const [tick, setTick] = createSignal(0);

  const read = (channelId: string): ChannelPulse | undefined => {
    tick();
    const p = channels.get(channelId);
    if (p) prune(p, now());
    return p;
  };

  return {
    record: (channelId, userId, at) => {
      let p = channels.get(channelId);
      if (!p) {
        p = { times: [], head: 0, lastSeen: new Map() };
        channels.set(channelId, p);
      }
      p.times.push(at);
      if (userId) {
        p.lastSeen.delete(userId);
        p.lastSeen.set(userId, at);
      }
      // Keeps background channels bounded without waiting for a read.
      prune(p, now());
    },
    perMinute: (channelId) => {
      const p = read(channelId);
      return p ? p.times.length - p.head : 0;
    },
    activeChatters: (channelId) => read(channelId)?.lastSeen.size ?? 0,
    retain: (channelIds) => {
      const keep = new Set(channelIds);
      for (const id of channels.keys()) {
        if (!keep.has(id)) channels.delete(id);
      }
    },
    start: () => {
      const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
      return () => clearInterval(timer);
    },
  };
}

const defaultStore = createPulseStore();
export const recordPulse = defaultStore.record;
export const messagesPerMinute = defaultStore.perMinute;
export const activeChatters = defaultStore.activeChatters;
export const retainPulse = defaultStore.retain;
export const startPulse = defaultStore.start;
