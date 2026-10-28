// A reply thread on its own: the message that started it and every reply
// still loaded, oldest first, with a button to join in.

import { Component, For, Show, createEffect, createMemo } from "solid-js";
import {
  findMessageById,
  messageRevision,
  searchMessages,
  type ChatMessage,
} from "../stores/chatStore";
import { closeThread, threadRoot, threadRootOf } from "../stores/threadStore";
import { requestReply } from "../stores/composerStore";
import { isLight } from "../stores/themeStore";
import { formatTimestamp, normalizeUserColor } from "../lib/messageStyle";
import { splitMessage } from "../lib/emoteSpans";
import { MESSAGE_LINE_HEIGHT } from "../lib/messageLayout";
import MessagePieces from "./MessagePieces";

export const MAX_REPLIES = 200;

const Row: Component<{ msg: ChatMessage }> = (props) => (
  <li class="search__row">
    <span class="msg__time">{formatTimestamp(props.msg.timestamp)}</span>
    <span
      class="search__name"
      style={{ color: normalizeUserColor(props.msg.color, isLight()) }}
    >
      {props.msg.display_name}
    </span>
    <span class="search__text">
      <MessagePieces
        pieces={splitMessage(props.msg.message_text, props.msg.emote_spans, {
          maxHeight: MESSAGE_LINE_HEIGHT,
        })}
      />
    </span>
  </li>
);

const Thread: Component = () => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (threadRoot()) queueMicrotask(() => dialogRef?.focus());
  });

  const thread = createMemo(() => {
    messageRevision();
    const root = threadRoot();
    if (!root) return null;
    const replies = searchMessages(
      (m) => threadRootOf(m) === root,
      MAX_REPLIES,
    ).reverse();
    return { origin: findMessageById(root), replies };
  });

  // The original can scroll out of memory; the first reply still quotes it.
  const quoted = () => thread()?.replies[0]?.reply_parent;

  const reply = () => {
    const t = thread();
    const last = t?.replies.at(-1) ?? t?.origin;
    if (!last) return;
    requestReply({
      message_id: last.id,
      user_login: last.username,
      user_name: last.display_name,
      body: last.message_text,
    });
    closeThread();
  };

  return (
    <Show when={thread()}>
      {(t) => (
        <div class="dialog-backdrop" onMouseDown={closeThread}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="dialog search"
            role="dialog"
            aria-modal="true"
            aria-label="Reply thread"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeThread();
            }}
          >
            <div class="dialog__title">
              Thread
              <button type="button" class="btn btn--small" onClick={reply}>
                Reply
              </button>
            </div>
            <ol class="search__list">
              <Show
                when={t().origin}
                fallback={
                  <Show when={quoted()}>
                    {(q) => (
                      <li class="search__row thread__quoted">
                        <span class="search__name">
                          {q().user_name || q().user_login}
                        </span>
                        <span class="search__text">{q().body}</span>
                      </li>
                    )}
                  </Show>
                }
              >
                {(origin) => <Row msg={origin()} />}
              </Show>
              <For each={t().replies}>{(m) => <Row msg={m} />}</For>
            </ol>
          </div>
        </div>
      )}
    </Show>
  );
};

export default Thread;
