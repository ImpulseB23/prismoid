// Room modes for one channel, as Twitch reports them. Loaded for every
// channel shown, so the composer knows about slow mode even for viewers,
// and kept current by Twitch's settings updates and, for moderators, after
// every mode action. The commands are injected for tests.

import { createSignal } from "solid-js";
import {
  getChatSettings,
  updateChatSettings,
  type ChatSettings,
  type ChatSettingsPatch,
} from "../lib/twitchChannel";
import type { ChatSettingsUpdate } from "../lib/chatEvents";
import { holdsModRole } from "./roleStore";

export interface ChatSettingsStore {
  settings: () => ChatSettings | null;
  /** Error from the last load or update, for the panel to show. */
  error: () => unknown;
  busy: () => boolean;
  /** Loads the modes of `channelId`; later `apply` calls change that channel. */
  load: (channelId: string) => Promise<void>;
  apply: (patch: ChatSettingsPatch) => Promise<void>;
  /** A live update from Twitch; ignored unless it is this channel's. */
  receive: (update: ChatSettingsUpdate) => void;
  clear: () => void;
}

export function createChatSettingsStore(
  fetch: (channelId: string) => Promise<ChatSettings | null> = (id) =>
    getChatSettings(id, holdsModRole(id)),
  update: (
    channelId: string,
    patch: ChatSettingsPatch,
  ) => Promise<ChatSettings> = updateChatSettings,
): ChatSettingsStore {
  const [settings, setSettings] = createSignal<ChatSettings | null>(null);
  const [error, setError] = createSignal<unknown>(null);
  const [busy, setBusy] = createSignal(false);
  let generation = 0;
  let channelId: string | null = null;

  async function load(channel: string): Promise<void> {
    const gen = ++generation;
    // Another channel's modes must never show while this one loads.
    if (channel !== channelId) {
      setSettings(null);
      setError(null);
      setBusy(false);
    }
    channelId = channel;
    try {
      const next = await fetch(channel);
      if (gen !== generation) return;
      setSettings(next);
      setError(null);
    } catch (e) {
      if (gen === generation) setError(e);
    }
  }

  async function apply(patch: ChatSettingsPatch): Promise<void> {
    if (channelId === null) return;
    const gen = ++generation;
    setBusy(true);
    try {
      const next = await update(channelId, patch);
      if (gen !== generation) return;
      setSettings(next);
      setError(null);
    } catch (e) {
      if (gen === generation) setError(e);
    } finally {
      if (gen === generation) setBusy(false);
    }
  }

  function receive(update: ChatSettingsUpdate): void {
    if (update.channel_id !== channelId) return;
    // Anything still loading would be older than this.
    generation++;
    const prev = settings();
    setSettings({
      emote_mode: update.emote_mode,
      follower_mode: update.follower_mode,
      follower_mode_duration: update.follower_mode_duration,
      slow_mode: update.slow_mode,
      slow_mode_wait_time: update.slow_mode_wait_time,
      subscriber_mode: update.subscriber_mode,
      unique_chat_mode: update.unique_chat_mode,
      non_moderator_chat_delay: prev?.non_moderator_chat_delay ?? false,
      non_moderator_chat_delay_duration:
        prev?.non_moderator_chat_delay_duration ?? null,
    });
    setError(null);
    setBusy(false);
  }

  return {
    settings,
    error,
    busy,
    load,
    apply,
    receive,
    clear: () => {
      generation++;
      channelId = null;
      setSettings(null);
      setError(null);
      setBusy(false);
    },
  };
}

export const MODE_ACTIONS = new Set([
  "slow",
  "slowoff",
  "followers",
  "followersoff",
  "emoteonly",
  "emoteonlyoff",
  "subscribers",
  "subscribersoff",
  "uniquechat",
  "uniquechatoff",
]);
