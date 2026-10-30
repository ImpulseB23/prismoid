// How chat looks and behaves for this user, opened from the gear beside the
// emote button, like the menu under Twitch's chat box. Settings that only
// change this app are saved with the rest of the settings.

import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import ChatIdentity from "./ChatIdentity";
import {
  settings,
  updateSettings,
  PAUSE_CHAT,
  type PauseChat,
  type Settings,
} from "../stores/settingsStore";

const PAUSE_LABEL: Record<PauseChat, string> = {
  scroll: "Scrolling up only",
  hover: "Mouse over chat",
  alt: "Holding Alt",
  hoverAlt: "Mouse over or Alt",
};

export interface ChatSettingsMenuProps {
  open: boolean;
  /** The signed-in user's login, for the identity preview. */
  login: string;
  /** The gear that toggles the menu; pressing it is not an outside click. */
  anchor: HTMLElement | undefined;
  onClose: () => void;
}

const ChatSettingsMenu: Component<ChatSettingsMenuProps> = (props) => {
  let rootRef: HTMLDivElement | undefined;
  const [identity, setIdentity] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setIdentity(false);
    queueMicrotask(() => rootRef?.querySelector("input")?.focus());
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef?.contains(target) || props.anchor?.contains(target)) return;
      props.onClose();
    };
    document.addEventListener("mousedown", onDown);
    onCleanup(() => document.removeEventListener("mousedown", onDown));
  });

  const save = (patch: Partial<Settings>) =>
    void updateSettings(patch).catch((err: unknown) =>
      console.error("chat settings", err),
    );

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        class="chat-settings"
        role="dialog"
        aria-label="Chat settings"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
            props.anchor?.focus();
          }
        }}
      >
        <Show
          when={!identity()}
          fallback={
            <>
              <div class="chat-settings__head">
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Back to chat settings"
                  onClick={() => setIdentity(false)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path
                      d="M7.5 2.5 4 6l3.5 3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <h2 class="chat-settings__title">Chat identity</h2>
              </div>
              <ChatIdentity login={props.login} />
            </>
          }
        >
          <h2 class="chat-settings__title">Chat settings</h2>
          <button
            type="button"
            class="settings__row settings__row--toggle chat-settings__link"
            onClick={() => setIdentity(true)}
          >
            <div class="settings__text">
              <span class="settings__name">Chat identity</span>
              <span class="settings__hint">
                Your name color, and how you look in chat
              </span>
            </div>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M4.5 2.5 8 6 4.5 9.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Readable colors</span>
              <span class="settings__hint">
                Lighten or darken names that are hard to read on this theme
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().readableColors}
              onChange={(e) =>
                save({ readableColors: e.currentTarget.checked })
              }
            />
          </label>
          <label class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Pause chat</span>
              <span class="settings__hint">
                Hold new messages back while reading
              </span>
            </div>
            <select
              class="modes__select"
              value={settings().pauseChat}
              onChange={(e) =>
                save({ pauseChat: e.currentTarget.value as PauseChat })
              }
            >
              <For each={PAUSE_CHAT}>
                {(mode) => <option value={mode}>{PAUSE_LABEL[mode]}</option>}
              </For>
            </select>
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Animated emotes</span>
              <span class="settings__hint">
                Off shows the first frame of animated emotes
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().animatedEmotes}
              onChange={(e) =>
                save({ animatedEmotes: e.currentTarget.checked })
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Timestamps</span>
              <span class="settings__hint">
                Show the time next to each message
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().showTimestamps}
              onChange={(e) =>
                save({ showTimestamps: e.currentTarget.checked })
              }
            />
          </label>
        </Show>
      </div>
    </Show>
  );
};

export default ChatSettingsMenu;
