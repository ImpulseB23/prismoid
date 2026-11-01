// A reply thread on its own: the message that started it and every reply
// still loaded, oldest first, with a button to join in.

import { Component, For, Show, createEffect, createMemo } from "solid-js";
import type { ChatMessage } from "../stores/chatStore";
import { threadRootOf } from "../stores/threadStore";
import { requirePane } from "../lib/pane";
import MessageRow from "./MessageRow";
import { jumpToMessage } from "../stores/jumpStore";
import PaletteClose from "./PaletteClose";

export const MAX_REPLIES = 200;

const Thread: Component = () => {
  const pane = requirePane();
  const session = pane.session;
  const { root: threadRoot, close: closeThread } = pane.thread;
  const { requestReply } = pane.composer;
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (threadRoot()) queueMicrotask(() => dialogRef?.focus());
  });

  const jump = (m: ChatMessage) => {
    closeThread();
    jumpToMessage(m.channel_id, m.id);
  };

  const thread = createMemo(() => {
    const chat = session().chat;
    const root = threadRoot();
    if (!root) return null;
    chat.messageRevision();
    const replies = chat
      .search((m) => threadRootOf(m) === root, MAX_REPLIES)
      .reverse();
    return { origin: chat.findById(root), replies };
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
        <div class="palette-backdrop" onMouseDown={closeThread}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Reply thread"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeThread();
            }}
          >
            <div class="palette__head">
              <span class="palette__title">Thread</span>
              <span class="palette__count">
                {t().replies.length}{" "}
                {t().replies.length === 1 ? "reply" : "replies"}
              </span>
              <span class="palette__head-actions">
                <PaletteClose onClick={closeThread} />
              </span>
            </div>
            <ol class="palette__body msg-list">
              <Show
                when={t().origin}
                fallback={
                  <Show when={quoted()}>
                    {(q) => (
                      <li class="msg-list__item">
                        <div class="msg-row msg-row--quoted">
                          <span class="msg-row__main">
                            <span class="msg-row__meta">
                              <span class="msg-row__name">
                                {q().user_name || q().user_login}
                              </span>
                              <span class="msg-row__detail">
                                no longer loaded
                              </span>
                            </span>
                            <span class="msg-row__text">{q().body}</span>
                          </span>
                        </div>
                      </li>
                    )}
                  </Show>
                }
              >
                {(origin) => (
                  <MessageRow msg={origin()} onClick={() => jump(origin())} />
                )}
              </Show>
              <For each={t().replies}>
                {(m) => <MessageRow msg={m} reply onClick={() => jump(m)} />}
              </For>
            </ol>
            <div class="palette__actions">
              <button
                type="button"
                class="btn btn--small btn--primary"
                onClick={reply}
              >
                Reply to thread
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default Thread;
