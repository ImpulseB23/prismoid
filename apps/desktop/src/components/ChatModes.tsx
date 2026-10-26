// Room modes for moderators: the same switches the Twitch dashboard has,
// reachable from the header. Every change goes straight to Twitch and the
// panel shows whatever Twitch answers with.

import { Component, For, Show, createEffect } from "solid-js";
import { formatChannelError } from "../lib/twitchChannel";
import { activeChannel } from "../stores/channelStore";
import {
  applyChatSettings,
  chatSettings,
  chatSettingsBusy,
  chatSettingsError,
  loadChatSettings,
} from "../stores/chatSettingsStore";

export interface ChatModesProps {
  open: boolean;
  onClose: () => void;
}

const SLOW_CHOICES = [3, 5, 10, 30, 60, 120];
const FOLLOWER_CHOICES: [label: string, minutes: number][] = [
  ["Any follower", 0],
  ["10 minutes", 10],
  ["30 minutes", 30],
  ["1 hour", 60],
  ["1 day", 1440],
  ["1 week", 10_080],
  ["1 month", 43_200],
];
const DELAY_CHOICES = [2, 4, 6];

const ChatModes: Component<ChatModesProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    const id = activeChannel()?.id;
    if (props.open && id !== undefined) {
      void loadChatSettings(id);
      queueMicrotask(() => dialogRef?.focus());
    }
  });

  const toggle = (label: string, checked: boolean) => {
    const s = chatSettings();
    if (!s) return;
    switch (label) {
      case "emote":
        return void applyChatSettings({ emote_mode: checked });
      case "subscriber":
        return void applyChatSettings({ subscriber_mode: checked });
      case "unique":
        return void applyChatSettings({ unique_chat_mode: checked });
      case "slow":
        return void applyChatSettings(
          checked
            ? { slow_mode: true, slow_mode_wait_time: 30 }
            : { slow_mode: false },
        );
      case "followers":
        return void applyChatSettings(
          checked
            ? { follower_mode: true, follower_mode_duration: 0 }
            : { follower_mode: false },
        );
      case "delay":
        return void applyChatSettings(
          checked
            ? {
                non_moderator_chat_delay: true,
                non_moderator_chat_delay_duration: 2,
              }
            : { non_moderator_chat_delay: false },
        );
    }
  };

  return (
    <Show when={props.open}>
      <div class="dialog-backdrop" onMouseDown={props.onClose}>
        <div
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="dialog modes"
          role="dialog"
          aria-modal="true"
          aria-label="Chat modes"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <div class="dialog__title">
            Chat modes
            <span class="modes__channel">{activeChannel()?.display_name}</span>
          </div>

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
                      value={s().slow_mode_wait_time ?? 30}
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
                      value={s().follower_mode_duration ?? 0}
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
                    onChange={(e) =>
                      toggle("followers", e.currentTarget.checked)
                    }
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
                    onChange={(e) =>
                      toggle("subscriber", e.currentTarget.checked)
                    }
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
      </div>
    </Show>
  );
};

export default ChatModes;
