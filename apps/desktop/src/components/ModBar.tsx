// Strip under the composer for whoever can moderate the open channel: who
// they are here, the room modes as one-tap chips, and the full modes panel.

import { Component, For, Show, createEffect } from "solid-js";
import { activeChannel } from "../stores/channelStore";
import { currentUserId } from "../stores/authStore";
import { canModerate } from "../stores/roleStore";
import {
  applyChatSettings,
  chatSettings,
  chatSettingsBusy,
  loadChatSettings,
} from "../stores/chatSettingsStore";
import { setModesOpen } from "../stores/modesPanelStore";
import { modLogOpen, setModLogOpen } from "../stores/modLogPanelStore";
import ModLog from "./ModLog";
import { chipLabel, isOn, patchFor, type ChatMode } from "../lib/chatModes";

const CHIPS: ChatMode[] = [
  "slow",
  "followers",
  "subscriber",
  "emote",
  "unique",
];

const ModBar: Component = () => {
  createEffect(() => {
    const id = activeChannel()?.id;
    if (id !== undefined && canModerate()) void loadChatSettings(id);
  });

  const broadcaster = () => activeChannel()?.id === currentUserId();

  return (
    <Show when={canModerate()}>
      <div class="modbar" role="toolbar" aria-label="Moderation">
        <span
          class="modbar__role"
          classList={{ "modbar__role--owner": broadcaster() }}
        >
          {broadcaster() ? "Your channel" : "Moderator"}
        </span>
        <div class="modbar__modes">
          <For each={CHIPS}>
            {(mode) => {
              const on = () => {
                const s = chatSettings();
                return s !== null && isOn(s, mode);
              };
              return (
                <button
                  type="button"
                  class="modbar__chip"
                  classList={{ "modbar__chip--on": on() }}
                  aria-pressed={on()}
                  disabled={chatSettings() === null || chatSettingsBusy()}
                  onClick={() => void applyChatSettings(patchFor(mode, !on()))}
                >
                  {chipLabel(chatSettings(), mode)}
                </button>
              );
            }}
          </For>
        </div>
        <button
          type="button"
          class="modbar__more"
          title="Every mod action in this channel this session"
          onClick={() => setModLogOpen(true)}
        >
          Log
        </button>
        <button
          type="button"
          class="modbar__more"
          title="All chat modes and durations"
          onClick={() => setModesOpen(true)}
        >
          Modes
        </button>
        <ModLog open={modLogOpen()} onClose={() => setModLogOpen(false)} />
      </div>
    </Show>
  );
};

export default ModBar;
