// Open channels (tabs), the one on screen, and a small persisted list of
// recently opened channels. The host commands are injected so the store
// can be exercised without a runtime; storage is injected for the same
// reason (see feedback: never mutate globals in tests).

import { createSignal } from "solid-js";
import {
  focusChannel as focusChannelCommand,
  joinChannel as joinChannelCommand,
  leaveChannel as leaveChannelCommand,
  rejoinChannel as rejoinChannelCommand,
  type Channel,
} from "../lib/twitchChannel";

export interface RecentChannel {
  login: string;
  display_name: string;
  profile_image_url: string;
}

export type ChannelStatus = "idle" | "connecting" | "ready" | "error";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChannelCommands {
  join: (login: string) => Promise<Channel>;
  leave: (channelId: string) => Promise<void>;
  focus: (channelId: string) => Promise<boolean>;
  rejoin: (channelId: string) => Promise<void>;
}

export const MAX_RECENTS = 8;
const RECENTS_KEY = "prismoid.channels.recent";
export const RECENT_DWELL_MS = 2 * 60_000;
const LAST_KEY = "prismoid.channels.last";
const TABS_KEY = "prismoid.channels.tabs";

export interface ChannelStore {
  /** Open channels in tab order. */
  tabs: () => Channel[];
  /** The channel on screen. */
  active: () => Channel | null;
  status: () => ChannelStatus;
  error: () => unknown;
  recents: () => RecentChannel[];
  /** Login persisted from the previous session, if any. */
  lastLogin: () => string | null;
  /**
   * Opens `login` as a tab (or finds its tab) and shows it. Concurrent
   * calls are safe: only the most recent one may update state. Rejects
   * with the resolver's error after recording it in `error()`. With
   * `remember` (a channel the user picked) it joins recents at once;
   * otherwise only after it has been on screen for a while.
   */
  select: (login: string, opts?: { remember?: boolean }) => Promise<Channel>;
  /**
   * Reopens the tabs from the previous session, showing the one that was
   * on screen, or `fallbackLogin` on a fresh install. Channels that fail
   * to resolve are skipped.
   */
  restore: (fallbackLogin: string) => Promise<void>;
  /** Shows an open tab. */
  focus: (channelId: string) => Promise<void>;
  /** Closes a tab; a neighbour takes over when it was the one on screen. */
  close: (channelId: string) => Promise<void>;
  forgetRecent: (login: string) => void;
  /** Twitch refuses to show `channelId`'s chat to this account. */
  bannedIn: (channelId: string) => boolean;
  /** Records the host's ban notice for any open tab. */
  markBanned: (channelId: string) => void;
  /** Reconnects a banned channel to see whether the ban still holds. */
  rejoin: (channelId: string) => Promise<void>;
  /** Counts a message that arrived for a tab not on screen. */
  noteUnread: (channelId: string) => void;
  unread: (channelId: string) => number;
}

export function createChannelStore(
  commands: ChannelCommands = {
    join: joinChannelCommand,
    leave: leaveChannelCommand,
    focus: focusChannelCommand,
    rejoin: rejoinChannelCommand,
  },
  storage: StorageLike | null = defaultStorage(),
): ChannelStore {
  const [tabs, setTabs] = createSignal<Channel[]>([]);
  const [active, setActive] = createSignal<Channel | null>(null);
  const [status, setStatus] = createSignal<ChannelStatus>("idle");
  const [error, setError] = createSignal<unknown>(null);
  const [bannedIds, setBannedIds] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [unreadById, setUnreadById] = createSignal<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [recents, setRecents] = createSignal<RecentChannel[]>(
    readRecents(storage),
  );
  let generation = 0;
  let dwell: ReturnType<typeof setTimeout> | undefined;

  function remember(channel: Channel): void {
    persistRecents(
      pushRecent(recents(), {
        login: channel.login,
        display_name: channel.display_name,
        profile_image_url: channel.profile_image_url,
      }),
    );
  }

  function persistRecents(list: RecentChannel[]): void {
    setRecents(list);
    write(storage, RECENTS_KEY, JSON.stringify(list));
  }

  function persistTabs(): void {
    write(storage, TABS_KEY, JSON.stringify(tabs().map((c) => c.login)));
    const a = active();
    if (a) write(storage, LAST_KEY, a.login);
  }

  // A channel opened some other way (the browser, last session) only
  // counts as recent once it has stayed on screen, so a misclick or a
  // passing browser tab does not land there.
  function watch(channel: Channel | null): void {
    clearTimeout(dwell);
    if (!channel) return;
    dwell = setTimeout(() => {
      if (active()?.id === channel.id) remember(channel);
    }, RECENT_DWELL_MS);
  }

  function show(channel: Channel): void {
    watch(channel);
    setActive(channel);
    setUnreadById((m) => {
      if (!m.has(channel.id)) return m;
      const next = new Map(m);
      next.delete(channel.id);
      return next;
    });
    setStatus("ready");
    persistTabs();
  }

  function addTab(channel: Channel): void {
    if (!tabs().some((c) => c.id === channel.id)) {
      setTabs((list) => [...list, channel]);
    }
  }

  async function select(
    login: string,
    opts: { remember?: boolean } = {},
  ): Promise<Channel> {
    const gen = ++generation;
    setStatus("connecting");
    setError(null);
    try {
      const channel = await commands.join(login);
      if (gen !== generation) return channel;
      addTab(channel);
      if (opts.remember) remember(channel);
      show(channel);
      return channel;
    } catch (e) {
      if (gen === generation) {
        setError(e);
        setStatus(active() ? "ready" : "error");
      }
      throw e;
    }
  }

  async function restore(fallbackLogin: string): Promise<void> {
    const saved = readTabs(storage);
    const last = read(storage, LAST_KEY);
    const logins = saved.length > 0 ? saved : [last ?? fallbackLogin];
    const gen = ++generation;
    setStatus("connecting");
    setError(null);
    let shown: Channel | null = null;
    for (const login of logins) {
      try {
        const channel = await commands.join(login);
        if (gen !== generation) return;
        addTab(channel);
        if (login === last || shown === null) shown = channel;
      } catch (e) {
        if (gen !== generation) return;
        setError(e);
      }
    }
    if (!shown) {
      setStatus("error");
      return;
    }
    // Each join focused itself on the host; put the remembered one back.
    if (shown.id !== tabs().at(-1)?.id) await commands.focus(shown.id);
    if (gen !== generation) return;
    show(shown);
  }

  async function focus(channelId: string): Promise<void> {
    const channel = tabs().find((c) => c.id === channelId);
    if (!channel || active()?.id === channelId) return;
    show(channel);
    await commands.focus(channelId);
  }

  async function close(channelId: string): Promise<void> {
    const list = tabs();
    const pos = list.findIndex((c) => c.id === channelId);
    if (pos < 0) return;
    const remaining = list.filter((c) => c.id !== channelId);
    setTabs(remaining);
    setBannedIds((s) => {
      if (!s.has(channelId)) return s;
      const next = new Set(s);
      next.delete(channelId);
      return next;
    });
    setUnreadById((m) => {
      if (!m.has(channelId)) return m;
      const next = new Map(m);
      next.delete(channelId);
      return next;
    });
    if (active()?.id === channelId) {
      const next = remaining[pos] ?? remaining.at(-1) ?? null;
      watch(next);
      setActive(next);
      if (next) {
        setUnreadById((m) => {
          const copy = new Map(m);
          copy.delete(next.id);
          return copy;
        });
      }
    }
    persistTabs();
    await commands.leave(channelId);
  }

  function forgetRecent(login: string): void {
    persistRecents(recents().filter((r) => r.login !== login));
  }

  function markBanned(channelId: string): void {
    if (!tabs().some((c) => c.id === channelId)) return;
    setBannedIds((s) => new Set([...s, channelId]));
  }

  // Optimistic: a channel that still refuses us answers the reconnect with
  // another ban notice, which flips this back.
  async function rejoinBanned(channelId: string): Promise<void> {
    setBannedIds((s) => {
      const next = new Set(s);
      next.delete(channelId);
      return next;
    });
    await commands.rejoin(channelId);
  }

  function noteUnread(channelId: string): void {
    if (active()?.id === channelId) return;
    if (!tabs().some((c) => c.id === channelId)) return;
    setUnreadById((m) => {
      const next = new Map(m);
      next.set(channelId, (m.get(channelId) ?? 0) + 1);
      return next;
    });
  }

  return {
    tabs,
    active,
    status,
    error,
    recents,
    lastLogin: () => read(storage, LAST_KEY),
    select,
    restore,
    focus,
    close,
    forgetRecent,
    bannedIn: (channelId) => bannedIds().has(channelId),
    markBanned,
    rejoin: rejoinBanned,
    noteUnread,
    unread: (channelId) => unreadById().get(channelId) ?? 0,
  };
}

export function pushRecent(
  list: RecentChannel[],
  entry: RecentChannel,
): RecentChannel[] {
  return [entry, ...list.filter((r) => r.login !== entry.login)].slice(
    0,
    MAX_RECENTS,
  );
}

function readRecents(storage: StorageLike | null): RecentChannel[] {
  const raw = read(storage, RECENTS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function readTabs(storage: StorageLike | null): string[] {
  const raw = read(storage, TABS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function isRecent(v: unknown): v is RecentChannel {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.login === "string" &&
    typeof r.display_name === "string" &&
    typeof r.profile_image_url === "string"
  );
}

// localStorage can throw when storage is disabled; a chat window that
// forgets its tabs is preferable to one that fails to boot.
function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // ignore: persistence is best-effort
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const defaultStore = createChannelStore();

export const channelTabs = defaultStore.tabs;
export const activeChannel = defaultStore.active;
export const channelStatus = defaultStore.status;
export const channelError = defaultStore.error;
export const recentChannels = defaultStore.recents;
export const lastChannelLogin = defaultStore.lastLogin;
export const selectChannel = defaultStore.select;
export const restoreChannels = defaultStore.restore;
export const focusChannel = defaultStore.focus;
export const closeChannel = defaultStore.close;
export const forgetRecentChannel = defaultStore.forgetRecent;
export const channelBannedIn = defaultStore.bannedIn;
export const markChannelBanned = defaultStore.markBanned;
export const rejoinChannel = defaultStore.rejoin;
export const noteUnread = defaultStore.noteUnread;
export const unreadCount = defaultStore.unread;
