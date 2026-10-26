// Moderator actions seen this session, indexed by the person they were
// aimed at, so a user card can show "timed out twice tonight, last by X".
// Room-wide actions (slow mode, clears) have no target and are not kept.

import { createSignal } from "solid-js";
import type { ModAction } from "../lib/chatEvents";

export const MAX_ACTIONS_PER_USER = 50;
export const MAX_TRACKED_USERS = 500;

export interface ModLogStore {
  record: (action: ModAction) => void;
  /** Newest first. */
  forUser: (userId: string) => ModAction[];
  revision: () => number;
  clear: () => void;
}

export function createModLogStore(): ModLogStore {
  // Insertion order doubles as recency: a user acted on again moves to the end.
  const byUser = new Map<string, ModAction[]>();
  const [revision, setRevision] = createSignal(0);

  function record(action: ModAction): void {
    if (!action.target_user_id) return;
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
    revision,
    clear: () => {
      byUser.clear();
      setRevision((r) => r + 1);
    },
  };
}

const defaultStore = createModLogStore();
export const recordModAction = defaultStore.record;
export const modActionsFor = defaultStore.forUser;
export const modLogRevision = defaultStore.revision;
export const clearModLog = defaultStore.clear;
