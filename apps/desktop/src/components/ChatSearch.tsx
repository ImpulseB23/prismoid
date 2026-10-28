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
import MessageRow from "./MessageRow";

export const MAX_RESULTS = 200;

export interface ChatSearchProps {
  open: boolean;
  onClose: () => void;
}

const FILTERS: [string, string][] = [
  ["from:", "Only messages from one chatter, e.g. from:forsen"],
  ["has:link", "Only messages with a link"],
];

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

  const addFilter = (token: string) => {
    const current = text().trimEnd();
    setText(current ? `${current} ${token}` : token);
    inputRef?.focus();
  };

  return (
    <Show when={props.open}>
      <div class="palette-backdrop" onMouseDown={props.onClose}>
        <div
          class="palette palette--wide"
          role="dialog"
          aria-modal="true"
          aria-label="Search chat"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <div class="palette__field">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="7"
                cy="7"
                r="4.5"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <input
              ref={(el) => (inputRef = el)}
              type="search"
              class="palette__input"
              placeholder={`Search ${activeChannel()?.display_name ?? "this"} chat`}
              aria-label="Search chat"
              autocomplete="off"
              spellcheck={false}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <kbd aria-hidden="true">Esc</kbd>
          </div>

          <div class="palette__body">
            <Show
              when={!isEmpty(parseQuery(text()))}
              fallback={
                <>
                  <div class="palette__label">Filters</div>
                  <For each={FILTERS}>
                    {([token, hint]) => (
                      <button
                        type="button"
                        class="palette__item"
                        onClick={() => addFilter(token)}
                      >
                        <code class="palette__token">{token}</code>
                        <span class="palette__item-login">{hint}</span>
                      </button>
                    )}
                  </For>
                </>
              }
            >
              <div class="palette__label">
                {results().length === MAX_RESULTS
                  ? `Newest ${MAX_RESULTS} matches`
                  : `${results().length} ${results().length === 1 ? "match" : "matches"}`}
              </div>
              <Show
                when={results().length > 0}
                fallback={
                  <div class="palette__empty">
                    Nothing in the loaded chat matches.
                  </div>
                }
              >
                <ol class="msg-list">
                  <For each={results()}>{(m) => <MessageRow msg={m} />}</For>
                </ol>
              </Show>
            </Show>
          </div>

          <div class="palette__footer">
            <span>Searches the chat loaded this session</span>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ChatSearch;
