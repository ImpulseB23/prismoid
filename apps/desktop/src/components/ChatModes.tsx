// Room modes for moderators: the same switches the Twitch dashboard has,
// shown inside the command center, the one place modes live. Every change
// goes straight to Twitch and the switches show whatever Twitch answers with.

import { Component, For, Show } from "solid-js";
import { formatChannelError } from "../lib/twitchChannel";
import {
  FOLLOWER_CHOICES,
  SLOW_CHOICES,
  patchFor,
  type ChatMode,
} from "../lib/chatModes";
import { settings } from "../stores/settingsStore";
import {
  applyChatSettings,
  chatSettings,
  chatSettingsBusy,
  chatSettingsError,
} from "../stores/chatSettingsStore";

const DELAY_CHOICES = [2, 4, 6];

const ChatModes: Component = () => {
  const toggle = (mode: ChatMode, checked: boolean) => {
    if (!chatSettings()) return;
    void applyChatSettings(
      patchFor(mode, checked, {
        slowSeconds: settings().defaultSlowSeconds,
        followerMinutes: settings().defaultFollowerMinutes,
      }),
    );
  };

  return (
    <div class="cc__body modes">
      <Show
        when={chatSettings()}
        fallback={
          <div class="dialog__empty">
            {chatSettingsError()
              ? formatChannelError(chatSettingsError())
              : "Loading"}
          </div>
        }
      >
        {(s) => (
          <>
            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Slow mode</span>
                <span class="settings__hint">
                  One message per chatter every few seconds
                </span>
              </div>
              <Show when={s().slow_mode}>
                <select
                  class="modes__select"
                  value={
                    s().slow_mode_wait_time ?? settings().defaultSlowSeconds
                  }
                  disabled={chatSettingsBusy()}
                  onChange={(e) =>
                    void applyChatSettings({
                      slow_mode: true,
                      slow_mode_wait_time: Number(e.currentTarget.value),
                    })
                  }
                >
                  <For each={SLOW_CHOICES}>
                    {(sec) => <option value={sec}>{sec}s</option>}
                  </For>
                </select>
              </Show>
              <input
                type="checkbox"
                class="switch"
                checked={s().slow_mode}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("slow", e.currentTarget.checked)}
              />
            </label>

            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Followers-only</span>
                <span class="settings__hint">
                  Only followers can chat, optionally after a wait
                </span>
              </div>
              <Show when={s().follower_mode}>
                <select
                  class="modes__select"
                  value={
                    s().follower_mode_duration ??
                    settings().defaultFollowerMinutes
                  }
                  disabled={chatSettingsBusy()}
                  onChange={(e) =>
                    void applyChatSettings({
                      follower_mode: true,
                      follower_mode_duration: Number(e.currentTarget.value),
                    })
                  }
                >
                  <For each={FOLLOWER_CHOICES}>
                    {([label, minutes]) => (
                      <option value={minutes}>{label}</option>
                    )}
                  </For>
                </select>
              </Show>
              <input
                type="checkbox"
                class="switch"
                checked={s().follower_mode}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("followers", e.currentTarget.checked)}
              />
            </label>

            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Subscribers-only</span>
              </div>
              <input
                type="checkbox"
                class="switch"
                checked={s().subscriber_mode}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("subscriber", e.currentTarget.checked)}
              />
            </label>

            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Emote-only</span>
              </div>
              <input
                type="checkbox"
                class="switch"
                checked={s().emote_mode}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("emote", e.currentTarget.checked)}
              />
            </label>

            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Unique chat</span>
                <span class="settings__hint">Blocks repeated messages</span>
              </div>
              <input
                type="checkbox"
                class="switch"
                checked={s().unique_chat_mode}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("unique", e.currentTarget.checked)}
              />
            </label>

            <label class="settings__row settings__row--toggle">
              <div class="settings__text">
                <span class="settings__name">Non-moderator delay</span>
                <span class="settings__hint">
                  Mods see messages a few seconds before everyone else
                </span>
              </div>
              <Show when={s().non_moderator_chat_delay}>
                <select
                  class="modes__select"
                  value={s().non_moderator_chat_delay_duration ?? 2}
                  disabled={chatSettingsBusy()}
                  onChange={(e) =>
                    void applyChatSettings({
                      non_moderator_chat_delay: true,
                      non_moderator_chat_delay_duration: Number(
                        e.currentTarget.value,
                      ),
                    })
                  }
                >
                  <For each={DELAY_CHOICES}>
                    {(sec) => <option value={sec}>{sec}s</option>}
                  </For>
                </select>
              </Show>
              <input
                type="checkbox"
                class="switch"
                checked={s().non_moderator_chat_delay}
                disabled={chatSettingsBusy()}
                onChange={(e) => toggle("delay", e.currentTarget.checked)}
              />
            </label>

            <Show when={chatSettingsError()}>
              {(err) => (
                <div class="dialog__error" role="alert">
                  {formatChannelError(err())}
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default ChatModes;
