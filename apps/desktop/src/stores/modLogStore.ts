// Moderator actions seen this session, kept two ways: by the person they
// were aimed at, so a user card can show "timed out twice tonight, last by
// X", and by channel for the mod log, which also keeps room-wide actions
// like slow mode and clears.

import { createSignal } from "solid-js";
import type { ModAction } from "../lib/chatEvents";

export const MAX_ACTIONS_PER_USER = 50;
export const MAX_TRACKED_USERS = 500;
export const MAX_ACTIONS_PER_CHANNEL = 300;

export interface ModLogStore {
  record: (action: ModAction) => void;
  /** Newest first. */
  forUser: (userId: string) => ModAction[];
  /** Newest first, room-wide actions included. */
  forChannel: (channelId: string) => ModAction[];
  revision: () => number;
  clear: () => void;
}

export function createModLogStore(): ModLogStore {
  // Insertion order doubles as recency: a user acted on again moves to the end.
  const byUser = new Map<string, ModAction[]>();
  const byChannel = new Map<string, ModAction[]>();
  const [revision, setRevision] = createSignal(0);

  function record(action: ModAction): void {
    const channel = byChannel.get(action.channel_id) ?? [];
    channel.unshift(action);
    if (channel.length > MAX_ACTIONS_PER_CHANNEL) {
      channel.length = MAX_ACTIONS_PER_CHANNEL;
    }
    byChannel.set(action.channel_id, channel);
    if (!action.target_user_id) {
      setRevision((r) => r + 1);
      return;
    }
    const list = byUser.get(action.target_user_id) ?? [];
    byUser.delete(action.target_user_id);
    list.unshift(action);
    if (list.length > MAX_ACTIONS_PER_USER) list.length = MAX_ACTIONS_PER_USER;
    byUser.set(action.target_user_id, list);
    if (byUser.size > MAX_TRACKED_USERS) {
      const oldest = byUser.keys().next().value;
      if (oldest !== undefined) byUser.delete(oldest);
    }
    setRevision((r) => r + 1);
  }

  return {
    record,
    forUser: (userId) => byUser.get(userId) ?? [],
    forChannel: (channelId) => byChannel.get(channelId) ?? [],
    revision,
    clear: () => {
      byUser.clear();
      byChannel.clear();
      setRevision((r) => r + 1);
    },
  };
}

const defaultStore = createModLogStore();
export const recordModAction = defaultStore.record;
export const modActionsFor = defaultStore.forUser;
export const modActionsIn = defaultStore.forChannel;
export const modLogRevision = defaultStore.revision;
export const clearModLog = defaultStore.clear;
