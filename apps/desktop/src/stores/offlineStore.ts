// Chats of streams that ended close on their own. Every open tab's live
// state is checked once a minute in one request; a channel seen live that
// goes offline starts a countdown its chat shows, with a way to keep it
// open. Writing in that chat restarts the countdown, so a conversation
// that outlives the stream is never cut off. A raid the channel sent just
// before is kept so the chat can offer to follow it. The user's own
// channel never closes.

import { createSignal } from "solid-js";
import type { RaidEvent } from "../lib/chatEvents";
import { getLiveChannels } from "../lib/twitchChannel";
import { channelTabs, closeChannel } from "./channelStore";
import { currentUserId } from "./authStore";
import { settings } from "./settingsStore";

export const LIVE_POLL_MS = 60_000;

export interface RaidTarget {
  login: string;
  name: string;
}

export interface OfflineDeps {
  live: (channelIds: string[]) => Promise<string[]>;
  tabs: () => string[];
  own: () => string | null;
  /** Minutes a chat stays after its stream ends; 0 keeps it open. */
  minutes: () => number;
  close: (channelId: string) => Promise<void>;
  now: () => number;
}

export interface OfflineStore {
  /** Seconds until the chat closes, or null when it is not counting down. */
  secondsLeft: (channelId: string) => number | null;
  /** Where the channel raided before its stream ended, if it did. */
  raidOf: (channelId: string) => RaidTarget | null;
  keepOpen: (channelId: string) => void;
  /** The user wrote in the chat: the countdown starts over. */
  noteActivity: (channelId: string) => void;
  noteRaid: (raid: RaidEvent) => void;
  /** Checks live states now and then every minute; returns a stop. */
  start: () => () => void;
  /** One live check, exposed for tests. */
  poll: () => Promise<void>;
}

export function createOfflineStore(deps: OfflineDeps): OfflineStore {
  const seenLive = new Set<string>();
  const [endsAt, setEndsAt] = createSignal<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [raids, setRaids] = createSignal<ReadonlyMap<string, RaidTarget>>(
    new Map(),
  );
  const [now, setNow] = createSignal(deps.now());
  let ticker: ReturnType<typeof setInterval> | undefined;

  function setEnd(channelId: string, at: number | null): void {
    setEndsAt((m) => {
      if (at === null && !m.has(channelId)) return m;
      const next = new Map(m);
      if (at === null) next.delete(channelId);
      else next.set(channelId, at);
      return next;
    });
    syncTicker();
  }

  function dropRaid(channelId: string): void {
    setRaids((m) => {
      if (!m.has(channelId)) return m;
      const next = new Map(m);
      next.delete(channelId);
      return next;
    });
  }

  // The once-a-second tick only runs while some chat is counting down.
  function syncTicker(): void {
    const counting = endsAt().size > 0;
    if (counting && ticker === undefined) {
      ticker = setInterval(tick, 1000);
    } else if (!counting && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function tick(): void {
    const t = deps.now();
    setNow(t);
    if (deps.minutes() === 0) {
      for (const id of endsAt().keys()) setEnd(id, null);
      return;
    }
    for (const [id, at] of endsAt()) {
      if (at > t) continue;
      setEnd(id, null);
      dropRaid(id);
      seenLive.delete(id);
      deps
        .close(id)
        .catch((err: unknown) => console.error("close ended chat", err));
    }
  }

  async function poll(): Promise<void> {
    const own = deps.own();
    const ids = deps.tabs().filter((id) => id !== own);
    const open = new Set(ids);
    for (const id of [...seenLive]) if (!open.has(id)) seenLive.delete(id);
    for (const id of endsAt().keys()) if (!open.has(id)) setEnd(id, null);
    for (const id of raids().keys()) if (!open.has(id)) dropRaid(id);
    if (ids.length === 0) return;
    const live = new Set(await deps.live(ids));
    const minutes = deps.minutes();
    for (const id of ids) {
      if (live.has(id)) {
        seenLive.add(id);
        setEnd(id, null);
        dropRaid(id);
      } else if (seenLive.delete(id) && minutes > 0) {
        setEnd(id, deps.now() + minutes * 60_000);
      }
    }
    setNow(deps.now());
  }

  return {
    secondsLeft: (channelId) => {
      const at = endsAt().get(channelId);
      return at === undefined
        ? null
        : Math.max(0, Math.ceil((at - now()) / 1000));
    },
    raidOf: (channelId) => raids().get(channelId) ?? null,
    keepOpen: (channelId) => setEnd(channelId, null),
    noteActivity: (channelId) => {
      if (!endsAt().has(channelId)) return;
      setEnd(channelId, deps.now() + deps.minutes() * 60_000);
      setNow(deps.now());
    },
    noteRaid: (raid) => {
      if (!deps.tabs().includes(raid.channel_id)) return;
      setRaids((m) =>
        new Map(m).set(raid.channel_id, {
          login: raid.to_user_login,
          name: raid.to_user_name || raid.to_user_login,
        }),
      );
    },
    start: () => {
      const run = () =>
        void poll().catch((err: unknown) => console.error("live check", err));
      run();
      const timer = setInterval(run, LIVE_POLL_MS);
      return () => {
        clearInterval(timer);
        if (ticker !== undefined) clearInterval(ticker);
        ticker = undefined;
      };
    },
    poll,
  };
}

const defaultStore = createOfflineStore({
  live: getLiveChannels,
  tabs: () => channelTabs().map((c) => c.id),
  own: currentUserId,
  minutes: () => settings().offlineCloseMinutes,
  close: closeChannel,
  now: Date.now,
});
export const offlineSecondsLeft = defaultStore.secondsLeft;
export const offlineRaidOf = defaultStore.raidOf;
export const keepEndedChatOpen = defaultStore.keepOpen;
export const noteChatActivity = defaultStore.noteActivity;
export const noteChannelRaid = defaultStore.noteRaid;
export const startOfflineWatch = defaultStore.start;
