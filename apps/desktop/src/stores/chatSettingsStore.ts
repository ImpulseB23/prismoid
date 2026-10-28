// Room modes for the active channel, as Twitch reports them. Loaded when
// the modes panel opens and after every moderator action that changes a
// mode, so the panel never shows a stale state after someone else flips
// slow mode. The commands are injected for tests.

import { createSignal } from "solid-js";
import {
  getChatSettings,
  updateChatSettings,
  type ChatSettings,
  type ChatSettingsPatch,
} from "../lib/twitchChannel";

export interface ChatSettingsStore {
  settings: () => ChatSettings | null;
  /** Error from the last load or update, for the panel to show. */
  error: () => unknown;
  busy: () => boolean;
  /** Loads the modes of `channelId`; later `apply` calls change that channel. */
  load: (channelId: string) => Promise<void>;
  apply: (patch: ChatSettingsPatch) => Promise<void>;
  clear: () => void;
}

export function createChatSettingsStore(
  fetch: (channelId: string) => Promise<ChatSettings | null> = getChatSettings,
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

  return {
    settings,
    error,
    busy,
    load,
    apply,
    clear: () => {
      generation++;
      channelId = null;
      setSettings(null);
      setError(null);
      setBusy(false);
    },
  };
}

const defaultStore = createChatSettingsStore();
export const chatSettings = defaultStore.settings;
export const chatSettingsError = defaultStore.error;
export const chatSettingsBusy = defaultStore.busy;
export const loadChatSettings = defaultStore.load;
export const applyChatSettings = defaultStore.apply;
export const clearChatSettings = defaultStore.clear;

/** Mod actions that change a room mode, so the panel refreshes on them. */
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
