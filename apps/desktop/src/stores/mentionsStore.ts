// Every message that mentioned the user this session, across all open
// channels, newest first. Unread counts what arrived since the panel was
// last opened.

import { createSignal } from "solid-js";
import type { ChatMessage } from "./chatStore";

export const MAX_MENTIONS = 200;

export interface MentionsStore {
  mentions: () => ChatMessage[];
  unread: () => number;
  open: () => boolean;
  record: (msg: ChatMessage) => void;
  setOpen: (open: boolean) => void;
  clear: () => void;
}

export function createMentionsStore(): MentionsStore {
  const [mentions, setMentions] = createSignal<ChatMessage[]>([]);
  const [unread, setUnread] = createSignal(0);
  const [open, setOpenSignal] = createSignal(false);
  // History replays and reconnects can deliver a message twice.
  const seen = new Set<string>();

  function record(msg: ChatMessage): void {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    const next = [msg, ...mentions()];
    for (const dropped of next.splice(MAX_MENTIONS)) seen.delete(dropped.id);
    setMentions(next);
    if (!open()) setUnread((n) => n + 1);
  }

  function setOpen(value: boolean): void {
    setOpenSignal(value);
    if (value) setUnread(0);
  }

  function clear(): void {
    seen.clear();
    setMentions([]);
    setUnread(0);
  }

  return { mentions, unread, open, record, setOpen, clear };
}

const defaultStore = createMentionsStore();
export const mentions = defaultStore.mentions;
export const unreadMentions = defaultStore.unread;
export const mentionsOpen = defaultStore.open;
export const recordMention = defaultStore.record;
export const setMentionsOpen = defaultStore.setOpen;
export const clearMentions = defaultStore.clear;
