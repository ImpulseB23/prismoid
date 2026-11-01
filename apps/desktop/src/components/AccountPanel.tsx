// Your account, opened from the avatar: who you are signed in as, the
// platforms the feed connects to, your badges in the open channel, and
// the way into Settings, which lands on whatever needs you, or out.

import { Component, For, Show, createEffect } from "solid-js";
import { createConfirmTap } from "../lib/confirmTap";
import type { Attention } from "../lib/settingsAttention";
import { UPCOMING_PLATFORMS } from "../lib/platforms";
import { sessionFor } from "../lib/chatSession";
import { activeChannel } from "../stores/channelStore";
import type { ChatMessage } from "../stores/chatStore";
import { reconnectScopes } from "../stores/roleStore";
import { openSettings } from "../stores/settingsPanelStore";
import GearIcon from "./GearIcon";
import PaletteClose from "./PaletteClose";
import TwitchReconnect from "./TwitchReconnect";

export interface AccountPanelProps {
  open: boolean;
  login: string;
  displayName: string;
  picture: string | undefined;
  badges: ChatMessage["badges"];
  /** The most urgent thing in Settings waiting on the user. */
  attention: Attention | null;
  onClose: () => void;
  onSignOut: () => void;
}

const AccountPanel: Component<AccountPanelProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.open) queueMicrotask(() => dialogRef?.focus());
  });

  const badges = () => {
    const store = sessionFor(activeChannel()?.id)?.badges;
    store?.revision();
    return props.badges.flatMap((b) => {
      const r = store?.resolve(b.set_id, b.id);
      return r ? [r] : [];
    });
  };

  // Signing out drops the session and every open tab, so it takes a second
  // click to go through.
  const signOut = createConfirmTap();

  return (
    <Show when={props.open}>
      <div class="palette-backdrop" onMouseDown={() => props.onClose()}>
        <div
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="palette"
          role="dialog"
          aria-modal="true"
          aria-label="Your account"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <div class="account__head">
            <Show
              when={props.picture}
              fallback={
                <span class="account__picture account__picture--initial">
                  {props.displayName.slice(0, 1)}
                </span>
              }
            >
              {(src) => (
                <img
                  class="account__picture"
                  src={src()}
                  alt=""
                  width={44}
                  height={44}
                  draggable={false}
                />
              )}
            </Show>
            <div class="account__who">
              <span class="account__name">{props.displayName}</span>
              <span class="account__login">{props.login}</span>
            </div>
            <PaletteClose onClick={() => props.onClose()} />
          </div>

          <Show when={activeChannel()}>
            {(channel) => (
              <div class="account__section">
                <span class="account__label">
                  In {channel().display_name}'s chat
                </span>
                <Show
                  when={badges().length > 0}
                  fallback={
                    <span class="account__hint">
                      No badges here yet. They show once you chat.
                    </span>
                  }
                >
                  <ul class="account__badges">
                    <For each={badges()}>
                      {(b) => (
                        <li class="account__badge">
                          <img
                            src={b.url_2x || b.url_1x}
                            alt=""
                            width={18}
                            height={18}
                            draggable={false}
                          />
                          {b.title}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>

          <div class="account__section">
            <span class="account__label">Connected</span>
            <div class="account__platform">
              <span class="account__platform-name">Twitch</span>
              <span class="account__hint">Signed in as {props.login}</span>
            </div>
            <Show when={reconnectScopes().length > 0}>
              <div class="account__reconnect">
                <TwitchReconnect
                  title="Twitch needs new permissions"
                  hint="Reconnect once to turn on what was added since you signed in."
                />
              </div>
            </Show>
            <For each={UPCOMING_PLATFORMS}>
              {(p) => (
                <div class="account__platform account__platform--soon">
                  <span class="account__platform-name">{p.name}</span>
                  <span class="account__hint">Coming soon</span>
                </div>
              )}
            </For>
          </div>

          <Show when={props.attention}>
            {(a) => (
              <p class="account__attention">
                <span class="account__attention-dot" aria-hidden="true" />
                {a().text}
              </p>
            )}
          </Show>
          <div class="account__actions">
            <button
              type="button"
              class="btn btn--outline account__settings"
              onClick={() => {
                openSettings(props.attention?.section);
                props.onClose();
              }}
            >
              <GearIcon size={14} />
              Settings
            </button>
            <button
              type="button"
              class="btn btn--outline"
              classList={{ "btn--danger": signOut.armed() }}
              onClick={() => {
                if (!signOut.tap()) return;
                props.onClose();
                props.onSignOut();
              }}
            >
              {signOut.armed() ? "Sign out?" : "Sign out"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default AccountPanel;
