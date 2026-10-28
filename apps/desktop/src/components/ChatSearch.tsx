// Ctrl+F: searches the loaded chat of the open channel. Words narrow the
// results, `from:name` picks one chatter and `has:link` keeps messages
// with links.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { activeChannel } from "../stores/channelStore";
import { messageRevision, searchMessages } from "../stores/chatStore";
import { isEmpty, matches, parseQuery } from "../lib/chatSearch";
import { formatTimestamp, normalizeUserColor } from "../lib/messageStyle";
import { splitMessage } from "../lib/emoteSpans";
import { MESSAGE_LINE_HEIGHT } from "../lib/messageLayout";
import { isLight } from "../stores/themeStore";
import MessagePieces from "./MessagePieces";

export const MAX_RESULTS = 200;

export interface ChatSearchProps {
  open: boolean;
  onClose: () => void;
}

const ChatSearch: Component<ChatSearchProps> = (props) => {
  const [text, setText] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) queueMicrotask(() => inputRef?.select());
  });

  const results = createMemo(() => {
    messageRevision();
    const q = parseQuery(text());
    const channel = activeChannel()?.id;
    if (isEmpty(q) || channel === undefined) return [];
    return searchMessages(
      (m) => m.channel_id === channel && matches(m, q),
      MAX_RESULTS,
    );
  });

  return (
    <Show when={props.open}>
      <div class="dialog-backdrop" onMouseDown={props.onClose}>
        <div
          class="dialog search"
          role="dialog"
          aria-modal="true"
          aria-label="Search chat"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <input
            ref={(el) => (inputRef = el)}
            type="search"
            class="search__input"
            placeholder="Search chat   from:name   has:link"
            aria-label="Search chat"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <Show
            when={!isEmpty(parseQuery(text()))}
            fallback={
              <div class="dialog__empty">
                Searches the chat loaded for{" "}
                {activeChannel()?.display_name ?? "this channel"}.
              </div>
            }
          >
            <div class="search__count">
              {results().length === MAX_RESULTS
                ? `Newest ${MAX_RESULTS} matches`
                : `${results().length} ${results().length === 1 ? "match" : "matches"}`}
            </div>
            <ol class="search__list">
              <For each={results()}>
                {(m) => (
                  <li class="search__row">
                    <span class="msg__time">
                      {formatTimestamp(m.timestamp)}
                    </span>
                    <span
                      class="search__name"
                      style={{ color: normalizeUserColor(m.color, isLight()) }}
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

export default ChatSearch;
