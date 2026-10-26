// Browsable emote grid above the composer. Channel sets come first, then
// global, each under its provider; the search box filters across all of
// them. Clicking an emote hands its code back to the composer.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { emoteGroups, emoteRevision } from "../stores/emoteStore";
import type { EmoteMeta } from "../stores/chatStore";

export interface EmotePickerProps {
  open: boolean;
  onPick: (emote: EmoteMeta) => void;
  onClose: () => void;
}

const EmotePicker: Component<EmotePickerProps> = (props) => {
  const [query, setQuery] = createSignal("");
  let inputRef: HTMLInputElement | undefined;
  let rootRef: HTMLDivElement | undefined;

  const groups = createMemo(() => {
    emoteRevision();
    const q = query().trim().toLowerCase();
    if (!q) return emoteGroups();
    return emoteGroups().flatMap((g) => {
      const emotes = g.emotes.filter((e) => e.code.toLowerCase().includes(q));
      return emotes.length > 0 ? [{ label: g.label, emotes }] : [];
    });
  });

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    queueMicrotask(() => inputRef?.focus());
    const onDown = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", onDown);
    onCleanup(() => document.removeEventListener("mousedown", onDown));
  });

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        class="emote-picker"
        role="dialog"
        aria-label="Emotes"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          }
        }}
      >
        <input
          ref={(el) => (inputRef = el)}
          class="emote-picker__search"
          type="text"
          placeholder="Search emotes"
          aria-label="Search emotes"
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="emote-picker__scroll">
          <Show
            when={groups().length > 0}
            fallback={
              <div class="dialog__empty">
                {emoteGroups().length === 0
                  ? "Emotes load once the channel connects."
                  : `No emotes match "${query().trim()}".`}
              </div>
            }
          >
            <For each={groups()}>
              {(g) => (
                <section>
                  <div class="emote-picker__label">{g.label}</div>
                  <div class="emote-picker__grid">
                    <For each={g.emotes}>
                      {(e) => (
                        <button
                          type="button"
                          class="emote-picker__cell"
                          title={e.code}
                          aria-label={e.code}
                          onClick={() => props.onPick(e)}
                        >
                          <img
                            src={e.url_1x}
                            alt=""
                            loading="lazy"
                            draggable={false}
                          />
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default EmotePicker;
