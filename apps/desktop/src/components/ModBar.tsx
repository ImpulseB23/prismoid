// Strip under the composer for whoever can moderate the open channel: who
// they are here, the room modes as one-tap chips, the AutoMod queue, and
// the full modes panel.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
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
import AutomodQueue from "./AutomodQueue";
import { pendingHeldCount } from "../stores/automodStore";
import { chipLabel, isOn, patchFor, type ChatMode } from "../lib/chatModes";
import { clearChat, type SendMessageError } from "../lib/twitchAuth";
import { formatSendError, toSendError } from "../lib/messageInput";

const CHIPS: ChatMode[] = [
  "slow",
  "followers",
  "subscriber",
  "emote",
  "unique",
];

/** How long the armed Clear button waits for the second tap. */
export const CLEAR_CONFIRM_MS = 4000;

const ModBar: Component = () => {
  createEffect(() => {
    const id = activeChannel()?.id;
    if (id !== undefined && canModerate()) void loadChatSettings(id);
  });

  const broadcaster = () => activeChannel()?.id === currentUserId();

  const [automodOpen, setAutomodOpen] = createSignal(false);
  const heldCount = () => {
    const id = activeChannel()?.id;
    return id === undefined ? 0 : pendingHeldCount(id);
  };

  const [armed, setArmed] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const [clearError, setClearError] = createSignal<string | null>(null);
  let disarm: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(disarm));

  createEffect(
    on(
      () => activeChannel()?.id,
      () => {
        clearTimeout(disarm);
        setArmed(false);
        setClearError(null);
      },
    ),
  );

  const onClear = async () => {
    const id = activeChannel()?.id;
    if (id === undefined) return;
    clearTimeout(disarm);
    if (!armed()) {
      setArmed(true);
      setClearError(null);
      disarm = setTimeout(() => setArmed(false), CLEAR_CONFIRM_MS);
      return;
    }
    setArmed(false);
    setClearing(true);
    try {
      await clearChat(id);
    } catch (raw) {
      const err = toSendError(raw);
      setClearError(
        typeof err === "string"
          ? err
          : formatSendError(err as SendMessageError),
      );
    } finally {
      setClearing(false);
    }
  };

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
              const active = () => {
                const s = chatSettings();
                return s !== null && isOn(s, mode);
              };
              return (
                <button
                  type="button"
                  class="modbar__chip"
                  classList={{ "modbar__chip--on": active() }}
                  aria-pressed={active()}
                  disabled={chatSettings() === null || chatSettingsBusy()}
                  onClick={() =>
                    void applyChatSettings(patchFor(mode, !active()))
                  }
                >
                  {chipLabel(chatSettings(), mode)}
                </button>
              );
            }}
          </For>
        </div>
        <Show when={clearError()}>
          {(msg) => (
            <span class="modbar__error" role="alert">
              {msg()}
            </span>
          )}
        </Show>
        <button
          type="button"
          class="modbar__more"
          classList={{ "modbar__more--danger": armed() }}
          title="Remove every message in this channel for everyone"
          disabled={clearing()}
          onClick={() => void onClear()}
        >
          {armed() ? "Clear chat?" : "Clear"}
        </button>
        <button
          type="button"
          class="modbar__more"
          title="Messages AutoMod is holding for review"
          onClick={() => setAutomodOpen(true)}
        >
          AutoMod
          <Show when={heldCount() > 0}>
            <span class="modbar__count">{heldCount()}</span>
          </Show>
        </button>
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
        <AutomodQueue
          open={automodOpen()}
          onClose={() => setAutomodOpen(false)}
        />
      </div>
    </Show>
  );
};

export default ModBar;
