// The badges the signed-in user wears in each channel, from their newest
// message there. The feed only holds the open channel's recent messages, so
// the account card reads this instead; it is kept on disk so a restart or a
// busy channel does not lose it.

import { createSignal } from "solid-js";
import type { ChatMessage } from "./chatStore";
import type { StorageLike } from "./channelStore";

const KEY = "prismoid.ownBadges";

type Badges = ChatMessage["badges"];

interface Entry {
  badges: Badges;
  /** When the message that carried them was sent, so older history loaded
   * later never replaces them. */
  at: number;
}

export interface OwnBadgeStore {
  /** Takes the badges from `msg` when it is the user's own and newest. */
  note: (msg: ChatMessage, selfId: string) => void;
  badges: (channelId: string) => Badges | undefined;
}

export function createOwnBadgeStore(
  storage: StorageLike | null = defaultStorage(),
): OwnBadgeStore {
  const [entries, setEntries] = createSignal<Record<string, Entry>>(
    read(storage),
  );

  function note(msg: ChatMessage, selfId: string): void {
    if (
      msg.platform !== "Twitch" ||
      msg.platform_user_id !== selfId ||
      msg.notice !== null ||
      msg.status !== undefined
    ) {
      return;
    }
    const prev = entries()[msg.channel_id];
    if (prev && prev.at >= msg.timestamp) return;
    const next = {
      ...entries(),
      [msg.channel_id]: { badges: msg.badges, at: msg.timestamp },
    };
    setEntries(next);
    write(storage, next);
  }

  return {
    note,
    badges: (channelId) => entries()[channelId]?.badges,
  };
}

function read(storage: StorageLike | null): Record<string, Entry> {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, Entry> = {};
    for (const [channel, e] of Object.entries(parsed)) {
      if (isEntry(e)) out[channel] = e;
    }
    return out;
  } catch {
    return {};
  }
}

function isEntry(e: unknown): e is Entry {
  if (typeof e !== "object" || e === null) return false;
  const { badges, at } = e as Partial<Entry>;
  return (
    typeof at === "number" &&
    Array.isArray(badges) &&
    badges.every(
      (b) => typeof b?.set_id === "string" && typeof b?.id === "string",
    )
  );
}

function write(storage: StorageLike | null, value: Record<string, Entry>) {
  try {
    storage?.setItem(KEY, JSON.stringify(value));
  } catch {
    // best-effort persistence
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const defaultStore = createOwnBadgeStore();
export const noteOwnBadges = defaultStore.note;
export const ownBadges = defaultStore.badges;
