// Room modes for moderators, as tiles in the chat manager: tap one to turn
// it on or off. Modes with a duration get a picker under the tiles while
// they are on. Every change goes straight to Twitch and the tiles show
// whatever Twitch answers with.

import { Component, For, Show } from "solid-js";
import { formatChannelError, type ChatSettings } from "../lib/twitchChannel";
import {
  FOLLOWER_CHOICES,
  SLOW_CHOICES,
  isOn,
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

const followerAge = (minutes: number | null) =>
  FOLLOWER_CHOICES.find(([, m]) => m === (minutes ?? 0))?.[0] ??
  `${minutes} min`;

const TILES: {
  mode: ChatMode;
  name: string;
  detail: (s: ChatSettings) => string;
}[] = [
  {
    mode: "slow",
    name: "Slow",
    detail: (s) => `${s.slow_mode_wait_time ?? 0} sec`,
  },
  {
    mode: "followers",
    name: "Followers",
    detail: (s) => followerAge(s.follower_mode_duration),
  },
  { mode: "subscriber", name: "Subs only", detail: () => "On" },
  { mode: "emote", name: "Emotes only", detail: () => "On" },
  { mode: "unique", name: "Unique", detail: () => "No repeats" },
  {
    mode: "delay",
    name: "Delay",
    detail: (s) => `${s.non_moderator_chat_delay_duration ?? 2} sec`,
  },
];

const ChatModes: Component = () => {
  const toggle = (s: ChatSettings, mode: ChatMode) =>
    void applyChatSettings(
      patchFor(mode, !isOn(s, mode), {
        slowSeconds: settings().defaultSlowSeconds,
        followerMinutes: settings().defaultFollowerMinutes,
      }),
    );

  return (
    <Show
      when={chatSettings()}
      fallback={
        <div class="cm-empty">
          {chatSettingsError()
            ? formatChannelError(chatSettingsError())
            : "Loading room modes"}
        </div>
      }
    >
      {(s) => (
        <>
          <div class="cm-tiles">
            <For each={TILES}>
              {(t) => (
                <button
                  type="button"
                  class="cm-tile"
                  classList={{ "cm-tile--on": isOn(s(), t.mode) }}
                  aria-pressed={isOn(s(), t.mode)}
                  disabled={chatSettingsBusy()}
                  onClick={() => toggle(s(), t.mode)}
                >
                  <span class="cm-tile__name">{t.name}</span>
                  <span class="cm-tile__detail">
                    {isOn(s(), t.mode) ? t.detail(s()) : "Off"}
                  </span>
                </button>
              )}
            </For>
          </div>

          <Show
            when={
              s().slow_mode || s().follower_mode || s().non_moderator_chat_delay
            }
          >
            <div class="cm-durations">
              <Show when={s().slow_mode}>
                <label class="cm-duration">
                  <span>One message every</span>
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
                      {(sec) => <option value={sec}>{sec} sec</option>}
                    </For>
                  </select>
                </label>
              </Show>
              <Show when={s().follower_mode}>
                <label class="cm-duration">
                  <span>Followed for</span>
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
                </label>
              </Show>
              <Show when={s().non_moderator_chat_delay}>
                <label class="cm-duration">
                  <span>Delay for non-mods</span>
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
                      {(sec) => <option value={sec}>{sec} sec</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </div>
          </Show>

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
  );
};

export default ChatModes;
