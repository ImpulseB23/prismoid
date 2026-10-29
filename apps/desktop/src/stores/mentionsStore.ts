// Every message that mentioned the user, across all open channels, newest
// first: live ones as they arrive, plus what each channel's stored history
// holds (which includes the recent-messages backlog from before the app was
// open). Unread counts mentions newer than the last time the panel was
// opened; that moment is remembered, so old mentions do not ping again on
// every launch.

import { createSignal } from "solid-js";
import type { ChatMessage } from "./chatStore";
import type { StorageLike } from "./channelStore";
import { loadHistory } from "../lib/chatHistory";
import { isHighlighted } from "../lib/highlight";

export const MAX_MENTIONS = 200;
const SEEN_KEY = "prismoid.mentionsSeenAt";
const CLEARED_KEY = "prismoid.mentionsClearedAt";

/** A message that should land in Mentions: it names the user or hits a highlight phrase, and is not theirs, a notice, or from someone ignored. */
export function isMentionFor(
  m: ChatMessage,
  login: string,
  phrases: string[],
  ignored: string[],
): boolean {
  return (
    !m.notice &&
    m.username !== login &&
    !ignored.includes(m.username) &&
    isHighlighted(m.message_text, login, phrases)
  );
}

export interface MentionsStore {
  mentions: () => ChatMessage[];
  unread: () => number;
  /**
   * Whether a mention was new when the list was opened, or arrived while it
   * is open. Opening marks everything read at once, so the list keeps what
   * was unread for as long as it stays open.
   */
  isNew: (msg: ChatMessage) => boolean;
  open: () => boolean;
  record: (msg: ChatMessage) => void;
  /** Looks through a channel's stored history once per session. */
  scanHistory: (
    channelId: string,
    isMention: (m: ChatMessage) => boolean,
  ) => Promise<void>;
  setOpen: (open: boolean) => void;
  /** The user cleared the list: hides everything up to now, for good. */
  clear: () => void;
  /** Sign-out: forgets this session's list without hiding anything. */
  reset: () => void;
}

export function createMentionsStore(
  storage: StorageLike | null = defaultStorage(),
  load: (channelId: string) => Promise<ChatMessage[]> = loadHistory,
  now: () => number = Date.now,
): MentionsStore {
  const [mentions, setMentions] = createSignal<ChatMessage[]>([]);
  const [open, setOpenSignal] = createSignal(false);
  const [seenAt, setSeenAtSignal] = createSignal(readTime(storage, SEEN_KEY));
  const [newSince, setNewSince] = createSignal(seenAt());
  // Clear hides everything up to that moment for good, so history scans on
  // later launches do not bring cleared mentions back.
  let clearedAt = readTime(storage, CLEARED_KEY);
  // History replays, reconnects and the live feed can all deliver a message.
  const seen = new Set<string>();
  const scanned = new Set<string>();

  const setSeenAt = (t: number) => {
    setSeenAtSignal(t);
    write(storage, SEEN_KEY, String(t));
  };

  function add(batch: ChatMessage[]): void {
    const fresh = batch.filter(
      (m) => !seen.has(m.id) && m.timestamp > clearedAt,
    );
    if (fresh.length === 0) return;
    for (const m of fresh) seen.add(m.id);
    const next = [...fresh, ...mentions()].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    for (const dropped of next.splice(MAX_MENTIONS)) seen.delete(dropped.id);
    setMentions(next);
    if (open()) setSeenAt(Math.max(seenAt(), now()));
  }

  async function scanHistory(
    channelId: string,
    isMention: (m: ChatMessage) => boolean,
  ): Promise<void> {
    if (scanned.has(channelId)) return;
    scanned.add(channelId);
    try {
      add((await load(channelId)).filter(isMention));
    } catch (err) {
      scanned.delete(channelId);
      console.error("mention history", err);
    }
  }

  const unread = () => mentions().filter((m) => m.timestamp > seenAt()).length;

  return {
    mentions,
    unread,
    isNew: (msg) => msg.timestamp > newSince(),
    open,
    record: (msg) => add([msg]),
    scanHistory,
    setOpen: (value) => {
      setOpenSignal(value);
      if (value) {
        setNewSince(seenAt());
        setSeenAt(now());
      }
    },
    clear: () => {
      clearedAt = now();
      write(storage, CLEARED_KEY, String(clearedAt));
      seen.clear();
      setMentions([]);
    },
    reset: () => {
      seen.clear();
      scanned.clear();
      setMentions([]);
    },
  };
}

function readTime(storage: StorageLike | null, key: string): number {
  try {
    const raw = storage?.getItem(key);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function write(storage: StorageLike | null, key: string, value: string): void {
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

const defaultStore = createMentionsStore();
export const mentions = defaultStore.mentions;
export const unreadMentions = defaultStore.unread;
export const isNewMention = defaultStore.isNew;
export const mentionsOpen = defaultStore.open;
export const recordMention = defaultStore.record;
export const scanMentionHistory = defaultStore.scanHistory;
export const setMentionsOpen = defaultStore.setOpen;
export const clearMentions = defaultStore.clear;
export const resetMentions = defaultStore.reset;
