// Browsable emote grid above the composer. Channel sets come first, then
// global, each under its provider; a rail on the left jumps between sets and
// the search box filters across all of them. The bar at the bottom previews
// the emote under the pointer. Clicking an emote hands its code back to the
// composer.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  emoteGroups,
  emoteRevision,
  type EmoteGroup,
} from "../stores/emoteStore";
import { activeChannel } from "../stores/channelStore";
import {
  emoteSetName,
  largeUrl,
  providerLabel,
} from "../stores/emoteCardStore";
import type { EmoteMeta } from "../stores/chatStore";
import ProviderIcon from "./ProviderIcon";

export interface EmotePickerProps {
  open: boolean;
  onPick: (emote: EmoteMeta) => void;
  onClose: () => void;
}

const setName = (g: EmoteGroup) =>
  g.emotes[0]
    ? emoteSetName(g.emotes[0], g.scope, activeChannel()?.display_name)
    : g.label;

const EmotePicker: Component<EmotePickerProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [hovered, setHovered] = createSignal<EmoteMeta | null>(null);
  const [current, setCurrent] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  const sections: HTMLElement[] = [];

  const groups = createMemo(() => {
    emoteRevision();
    const q = query().trim().toLowerCase();
    if (!q) return emoteGroups();
    return emoteGroups().flatMap((g) => {
      const emotes = g.emotes.filter((e) => e.code.toLowerCase().includes(q));
      return emotes.length > 0 ? [{ ...g, emotes }] : [];
    });
  });

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setHovered(null);
    setCurrent(0);
    queueMicrotask(() => inputRef?.focus());
    const onDown = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", onDown);
    onCleanup(() => document.removeEventListener("mousedown", onDown));
  });

  // The rail marks the set whose header is at or above the top of the list.
  const onScroll = () => {
    const box = scrollRef;
    if (!box) return;
    const top = box.scrollTop + 1;
    let index = 0;
    sections.forEach((el, i) => {
      if (el.offsetTop - box.offsetTop <= top) index = i;
    });
    setCurrent(index);
  };

  // Sections fill in by index as they render; a narrower search drops the rest.
  createEffect(() => {
    sections.length = groups().length;
  });

  const jump = (i: number) => {
    const el = sections[i];
    if (!el || !scrollRef) return;
    scrollRef.scrollTo({ top: el.offsetTop - scrollRef.offsetTop });
    setCurrent(i);
  };

  const channelAvatar = () => activeChannel()?.profile_image_url;

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
        <div class="palette__field emote-picker__field">
          <svg
            width="14"
            height="14"
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
            class="palette__input"
            type="text"
            placeholder="Search emotes"
            aria-label="Search emotes"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              scrollRef?.scrollTo({ top: 0 });
            }}
          />
        </div>

        <div class="emote-picker__main">
          <Show when={!query().trim() && groups().length > 1}>
            <nav class="emote-picker__rail" aria-label="Emote sets">
              <For each={groups()}>
                {(g, i) => (
                  <button
                    type="button"
                    class="emote-picker__rail-btn"
                    classList={{
                      "emote-picker__rail-btn--on": current() === i(),
                    }}
                    title={setName(g)}
                    aria-label={setName(g)}
                    onClick={() => jump(i())}
                  >
                    <Show
                      when={g.scope === "channel" && channelAvatar()}
                      fallback={
                        <ProviderIcon
                          provider={g.emotes[0]?.provider ?? "twitch"}
                          size={18}
                        />
                      }
                    >
                      {(src) => (
                        <>
                          <img
                            class="emote-picker__rail-avatar"
                            src={src()}
                            alt=""
                            draggable={false}
                          />
                          <span class="emote-picker__rail-badge">
                            <ProviderIcon
                              provider={g.emotes[0]?.provider ?? "twitch"}
                              size={10}
                            />
                          </span>
                        </>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </nav>
          </Show>

          <div
            ref={(el) => (scrollRef = el)}
            class="emote-picker__scroll"
            onScroll={onScroll}
          >
            <Show
              when={groups().length > 0}
              fallback={
                <div class="palette__empty palette__empty--center">
                  {emoteGroups().length === 0
                    ? "Emotes load once the channel connects."
                    : `No emotes match "${query().trim()}".`}
                </div>
              }
            >
              <For each={groups()}>
                {(g, i) => (
                  <section ref={(el) => (sections[i()] = el)}>
                    <div class="emote-picker__head">
                      <ProviderIcon
                        provider={g.emotes[0]?.provider ?? "twitch"}
                        size={12}
                      />
                      <span>{setName(g)}</span>
                      <span class="emote-picker__head-count">
                        {g.emotes.length}
                      </span>
                    </div>
                    <div class="emote-picker__grid">
                      <For each={g.emotes}>
                        {(e) => (
                          <button
                            type="button"
                            class="emote-picker__cell"
                            aria-label={e.code}
                            onPointerEnter={() => setHovered(e)}
                            onFocus={() => setHovered(e)}
                            onClick={() => props.onPick(e)}
                          >
                            <img
                              src={e.url_2x || e.url_1x}
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

        <div class="emote-picker__preview">
          <Show
            when={hovered()}
            fallback={
              <span class="emote-picker__preview-hint">
                {groups().reduce((n, g) => n + g.emotes.length, 0)} emotes
              </span>
            }
          >
            {(e) => (
              <>
                <img
                  class="emote-picker__preview-img"
                  src={largeUrl(e())}
                  alt=""
                  draggable={false}
                />
                <span class="emote-picker__preview-text">
                  <span class="emote-picker__preview-code">{e().code}</span>
                  <span class="emote-picker__preview-set">
                    <ProviderIcon provider={e().provider} size={12} />
                    <Show
                      when={e().owner}
                      fallback={<>{providerLabel(e().provider)}</>}
                    >
                      {(o) => <>by {o().display_name}</>}
                    </Show>
                  </span>
                </span>
              </>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default EmotePicker;
