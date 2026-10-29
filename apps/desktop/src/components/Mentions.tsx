// Everything said to you this session in any open channel. Picking one
// jumps to it in its channel.

import { Component, For, Show, createEffect } from "solid-js";
import { createConfirmTap } from "../lib/confirmTap";
import { channelTabs } from "../stores/channelStore";
import { jumpToMessage } from "../stores/jumpStore";
import {
  clearMentions,
  isNewMention,
  mentions,
  mentionsOpen,
  setMentionsOpen,
} from "../stores/mentionsStore";
import MessageRow from "./MessageRow";
import PaletteClose from "./PaletteClose";

const Mentions: Component = () => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (mentionsOpen()) queueMicrotask(() => dialogRef?.focus());
  });

  const channelOf = (id: string) => channelTabs().find((c) => c.id === id);

  const close = () => setMentionsOpen(false);

  // Clearing cannot be undone, so the first tap only arms the button.
  const { armed, tap } = createConfirmTap();
  const onClear = () => {
    if (tap()) clearMentions();
  };

  return (
    <Show when={mentionsOpen()}>
      <div class="palette-backdrop" onMouseDown={close}>
        <div
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="palette palette--wide"
          role="dialog"
          aria-modal="true"
          aria-label="Mentions"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <div class="palette__head">
            <span class="palette__title">Mentions</span>
            <Show when={mentions().length > 0}>
              <span class="palette__count">{mentions().length}</span>
            </Show>
            <span class="palette__head-actions">
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
              <PaletteClose onClick={close} />
            </span>
          </div>

          <div class="palette__body">
            <Show
              when={mentions().length > 0}
              fallback={
                <div class="palette__empty palette__empty--center">
                  <span class="palette__empty-title">No mentions yet</span>
                  Messages that mention you or match a highlight phrase, in any
                  open channel, collect here.
                </div>
              }
            >
              <ol class="msg-list">
                <For each={mentions()}>
                  {(m) => {
                    const channel = () => channelOf(m.channel_id);
                    return (
                      <MessageRow
                        msg={m}
                        unread={isNewMention(m)}
                        lead={
                          <Show
                            when={channel()?.profile_image_url}
                            fallback={<span class="msg-row__avatar" />}
                          >
                            {(src) => (
                              <img class="msg-row__avatar" src={src()} alt="" />
                            )}
                          </Show>
                        }
                        detail={
                          <Show when={channel()}>
                            {(c) => <>in {c().display_name}</>}
                          </Show>
                        }
                        onClick={() => {
                          close();
                          jumpToMessage(m.channel_id, m.id);
                        }}
                      />
                    );
                  }}
                </For>
              </ol>
            </Show>
          </div>

          <Show when={mentions().length > 0}>
            <div class="palette__footer">
              <span>Click a mention to jump to it</span>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default Mentions;
