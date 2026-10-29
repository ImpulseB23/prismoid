// How the signed-in user looks in chat: their name color, which Twitch
// keeps per account, and their badges and display name in each channel,
// from their newest message there. The feed only holds the open channel's
// recent messages, so the account panel and a message still being sent read
// this instead; it is kept on disk so a restart or a busy channel does not
// lose it.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./chatStore";
import type { StorageLike } from "./channelStore";

// The key predates the color and display name; entries without a display
// name still load.
const KEY = "prismoid.ownBadges";
const COLOR_KEY = "prismoid.ownColor";

type Badges = ChatMessage["badges"];

interface Entry {
  badges: Badges;
  display_name?: string;
  /** When the message that carried them was sent, so older history loaded
   * later never replaces them. */
  at: number;
}

export interface OwnIdentityStore {
  /** Takes what `msg` shows when it is the user's own and newest. */
  note: (msg: ChatMessage, selfId: string) => void;
  badges: (channelId: string) => Badges | undefined;
  displayName: (channelId: string) => string | undefined;
  color: () => string | null;
  setColor: (color: string | null) => void;
}

export function createOwnIdentityStore(
  storage: StorageLike | null = defaultStorage(),
): OwnIdentityStore {
  const [entries, setEntries] = createSignal<Record<string, Entry>>(
    read(storage),
  );
  const [color, setColorSignal] = createSignal<string | null>(
    readColor(storage),
  );

  function setColor(next: string | null): void {
    if (next === color()) return;
    setColorSignal(next);
    writeRaw(storage, COLOR_KEY, next ?? "");
  }

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
    if (msg.color) setColor(msg.color);
    const next = {
      ...entries(),
      [msg.channel_id]: {
        badges: msg.badges,
        display_name: msg.display_name,
        at: msg.timestamp,
      },
    };
    setEntries(next);
    writeRaw(storage, KEY, JSON.stringify(next));
  }

  return {
    note,
    badges: (channelId) => entries()[channelId]?.badges,
    displayName: (channelId) => entries()[channelId]?.display_name,
    color,
    setColor,
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

function readColor(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(COLOR_KEY) || null;
  } catch {
    return null;
  }
}

function isEntry(e: unknown): e is Entry {
  if (typeof e !== "object" || e === null) return false;
  const { badges, at, display_name } = e as Partial<Entry>;
  return (
    typeof at === "number" &&
    (display_name === undefined || typeof display_name === "string") &&
    Array.isArray(badges) &&
    badges.every(
      (b) => typeof b?.set_id === "string" && typeof b?.id === "string",
    )
  );
}

function writeRaw(storage: StorageLike | null, key: string, value: string) {
  try {
    storage?.setItem(key, value);
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

const defaultStore = createOwnIdentityStore();
export const noteOwnMessage = defaultStore.note;
export const ownBadges = defaultStore.badges;
export const ownDisplayName = defaultStore.displayName;
export const ownColor = defaultStore.color;

/** Asks Twitch for the user's name color; their messages keep it current. */
export async function loadOwnColor(): Promise<void> {
  defaultStore.setColor(await invoke<string | null>("twitch_own_chat_color"));
}
