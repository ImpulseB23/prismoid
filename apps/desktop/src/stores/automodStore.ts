// Messages AutoMod is holding for review, per channel, newest first. A
// resolved one (allowed or denied by any mod, or expired) keeps its
// outcome on screen for a moment and then drops off.

import { createSignal } from "solid-js";
import type { HeldMessage, HeldMessageResolved } from "../lib/chatEvents";

export const MAX_HELD_PER_CHANNEL = 100;
export const RESOLVED_LINGER_MS = 8000;

export type HeldStatus = "pending" | HeldMessageResolved["status"];

export interface HeldEntry {
  message: HeldMessage;
  status: HeldStatus;
  /** Display name of the mod who resolved it, when Twitch said. */
  by: string;
}

export interface AutomodStore {
  hold: (m: HeldMessage) => void;
  resolve: (e: HeldMessageResolved) => void;
  /** Newest first, resolved ones included until they drop off. */
  entries: (channelId: string) => HeldEntry[];
  pendingCount: (channelId: string) => number;
  clear: () => void;
}

export function createAutomodStore(
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): AutomodStore {
  const [byChannel, setByChannel] = createSignal<
    ReadonlyMap<string, readonly HeldEntry[]>
  >(new Map());
  let generation = 0;

  function update(
    channelId: string,
    fn: (list: readonly HeldEntry[]) => readonly HeldEntry[],
  ): void {
    const next = new Map(byChannel());
    const list = fn(next.get(channelId) ?? []);
    if (list.length === 0) next.delete(channelId);
    else next.set(channelId, list);
    setByChannel(next);
  }

  function hold(m: HeldMessage): void {
    const list = byChannel().get(m.channel_id) ?? [];
    if (list.some((e) => e.message.message_id === m.message_id)) return;
    update(m.channel_id, (l) =>
      [{ message: m, status: "pending" as const, by: "" }, ...l].slice(
        0,
        MAX_HELD_PER_CHANNEL,
      ),
    );
  }

  function resolve(e: HeldMessageResolved): void {
    const list = byChannel().get(e.channel_id) ?? [];
    const entry = list.find((x) => x.message.message_id === e.message_id);
    if (!entry) return;
    const by = e.moderator_name || e.moderator_login;
    update(e.channel_id, (l) =>
      l.map((x) => (x === entry ? { ...x, status: e.status, by } : x)),
    );
    // Our own allow or deny resolves locally first; Twitch's update then
    // only fills in the name, and the entry keeps its first timer.
    if (entry.status !== "pending") return;
    const gen = generation;
    schedule(() => {
      if (gen !== generation) return;
      update(e.channel_id, (l) =>
        l.filter((x) => x.message.message_id !== e.message_id),
      );
    }, RESOLVED_LINGER_MS);
  }

  return {
    hold,
    resolve,
    entries: (channelId) => [...(byChannel().get(channelId) ?? [])],
    pendingCount: (channelId) =>
      (byChannel().get(channelId) ?? []).filter((e) => e.status === "pending")
        .length,
    clear: () => {
      generation++;
      setByChannel(new Map());
    },
  };
}

const defaultStore = createAutomodStore();
export const recordHeldMessage = defaultStore.hold;
export const resolveHeldMessage = defaultStore.resolve;
export const heldMessagesIn = defaultStore.entries;
export const pendingHeldCount = defaultStore.pendingCount;
export const clearHeldMessages = defaultStore.clear;
