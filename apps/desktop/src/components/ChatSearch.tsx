// Ctrl+F: searches the loaded chat of the open channel. Words narrow the
// results and filters work like Discord's: typing offers the filter keys,
// then the values for the key (people for from: and mentions:), and each
// filter in use shows as a chip that removes it.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { activeChannel } from "../stores/channelStore";
import { sessionFor } from "../lib/chatSession";
import { isFirstMessage } from "../stores/firstMessageStore";
import {
  applySuggestion,
  filterTokens,
  isEmpty,
  matches,
  parseQuery,
  removeToken,
  suggest,
} from "../lib/chatSearch";
import MessageRow from "./MessageRow";
import { jumpToMessage } from "../stores/jumpStore";

export const MAX_RESULTS = 200;

export interface ChatSearchProps {
  open: boolean;
  onClose: () => void;
}

const ChatSearch: Component<ChatSearchProps> = (props) => {
  const [text, setText] = createSignal("");
  const [picked, setPicked] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) queueMicrotask(() => inputRef?.select());
  });

  const query = createMemo(() => parseQuery(text()));
  const chips = createMemo(() => filterTokens(text()));
  // Search looks through the channel on screen.
  const session = () => sessionFor(activeChannel()?.id);
  const suggestions = createMemo(() =>
    suggest(text(), session()?.chatters.recent() ?? []),
  );

  createEffect(() => {
    suggestions();
    setPicked(0);
  });

  const results = createMemo(() => {
    const s = session();
    const q = query();
    if (isEmpty(q) || !s) return [];
    s.chat.messageRevision();
    const ctx = {
      isFirst: isFirstMessage,
      isEmote: (w: string) => s.emotes.byCode(w) !== undefined,
    };
    return s.chat.search(
      (m) => m.channel_id === s.channelId && matches(m, q, ctx),
      MAX_RESULTS,
    );
  });

  const update = (next: string) => {
    setText(next);
    inputRef?.focus();
  };

  const pick = (i: number) => {
    const s = suggestions()[i];
    if (s) update(applySuggestion(text(), s));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const count = suggestions().length;
    if (e.key === "Escape") {
      props.onClose();
    } else if (count > 0 && e.key === "ArrowDown") {
      e.preventDefault();
      setPicked((i) => (i + 1) % count);
    } else if (count > 0 && e.key === "ArrowUp") {
      e.preventDefault();
      setPicked((i) => (i - 1 + count) % count);
    } else if (count > 0 && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      pick(picked());
    }
  };

  return (
    <Show when={props.open}>
      <div class="palette-backdrop" onMouseDown={props.onClose}>
        <div
          class="palette"
          role="dialog"
          aria-modal="true"
          aria-label="Search chat"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
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
              aria-autocomplete="list"
              aria-controls="chat-search-suggestions"
              autocomplete="off"
              spellcheck={false}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <kbd aria-hidden="true">Esc</kbd>
          </div>

          <Show when={chips().length > 0}>
            <div class="search-chips">
              <For each={chips()}>
                {(c) => (
                  <span class="search-chip">
                    <span class="search-chip__key">{c.key}:</span>
                    {c.value}
                    <button
                      type="button"
                      class="search-chip__remove"
                      aria-label={`Remove ${c.key}:${c.value}`}
                      onClick={() => update(removeToken(text(), c.raw))}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                      >
                        <path
                          d="M2 2l6 6M8 2 2 8"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>

          <div class="palette__body">
            <Show when={suggestions().length > 0}>
              <div class="palette__label">
                {/:\S*$/.test(text()) ? "Pick one" : "Search options"}
              </div>
              <ul
                id="chat-search-suggestions"
                class="search-suggestions"
                role="listbox"
                aria-label="Search options"
              >
                <For each={suggestions()}>
                  {(s, i) => (
                    <li
                      class="palette__item"
                      classList={{ "palette__item--on": picked() === i() }}
                      role="option"
                      aria-selected={picked() === i()}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setPicked(i())}
                      onClick={() => pick(i())}
                    >
                      <code class="palette__token">{s.label}</code>
                      <span class="palette__item-login">{s.hint}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={!isEmpty(query())}>
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
                  <For each={results()}>
                    {(m) => (
                      <MessageRow
                        msg={m}
                        onClick={() => {
                          props.onClose();
                          jumpToMessage(m.channel_id, m.id);
                        }}
                      />
                    )}
                  </For>
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
