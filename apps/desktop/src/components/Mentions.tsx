// Everything said to you this session in any open channel. Picking one
// jumps to its channel.

import { Component, For, Show, createEffect } from "solid-js";
import { createConfirmTap } from "../lib/confirmTap";
import { channelTabs, focusChannel } from "../stores/channelStore";
import {
  clearMentions,
  mentions,
  mentionsOpen,
  setMentionsOpen,
} from "../stores/mentionsStore";
import { isLight } from "../stores/themeStore";
import { formatTimestamp, normalizeUserColor } from "../lib/messageStyle";
import { splitMessage } from "../lib/emoteSpans";
import { MESSAGE_LINE_HEIGHT } from "../lib/messageLayout";
import MessagePieces from "./MessagePieces";

const Mentions: Component = () => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (mentionsOpen()) queueMicrotask(() => dialogRef?.focus());
  });

  const channelName = (id: string) =>
    channelTabs().find((c) => c.id === id)?.display_name;

  const close = () => setMentionsOpen(false);

  // Clearing cannot be undone, so the first tap only arms the button.
  const { armed, tap } = createConfirmTap();
  const onClear = () => {
    if (tap()) clearMentions();
  };

  return (
    <Show when={mentionsOpen()}>
      <div class="dialog-backdrop" onMouseDown={close}>
        <div
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="dialog search"
          role="dialog"
          aria-modal="true"
          aria-label="Mentions"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <div class="dialog__title">
            Mentions
            <Show when={mentions().length > 0}>
              <button
                type="button"
                class="btn btn--small"
                classList={{ "btn--danger": armed() }}
                title="Removes these mentions for good"
                onClick={onClear}
              >
                {armed() ? "Clear all?" : "Clear"}
              </button>
            </Show>
          </div>
          <Show
            when={mentions().length > 0}
            fallback={
              <div class="dialog__empty">
                Nobody has said your name yet. Messages that mention you or
                match a highlight phrase, in any open channel, collect here.
              </div>
            }
          >
            <ol class="search__list">
              <For each={mentions()}>
                {(m) => (
                  <li>
                    <button
                      type="button"
                      class="search__row mentions__row"
                      onClick={() => {
                        close();
                        void focusChannel(m.channel_id);
                      }}
                    >
                      <span class="msg__time">
                        {formatTimestamp(m.timestamp)}
                      </span>
                      <Show when={channelName(m.channel_id)}>
                        {(name) => (
                          <span class="mentions__channel">{name()}</span>
                        )}
                      </Show>
                      <span
                        class="search__name"
                        style={{
                          color: normalizeUserColor(m.color, isLight()),
                        }}
                      >
                        {m.display_name}
                      </span>
                      <span class="search__text">
                        <MessagePieces
                          pieces={splitMessage(m.message_text, m.emote_spans, {
                            maxHeight: MESSAGE_LINE_HEIGHT,
                          })}
                        />
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default Mentions;
