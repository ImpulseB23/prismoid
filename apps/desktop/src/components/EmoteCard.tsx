// Opens when an emote in a message is clicked: the emote at full size, its
// name, where it comes from, and ways to use it or look it up.

import { Component, Show, createEffect, createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  closeEmoteCard,
  inspectedEmote,
  providerLabel,
  providerPage,
} from "../stores/emoteCardStore";
import { requestInsert } from "../stores/composerStore";
import { emoteRevision, emoteScopeLabel } from "../stores/emoteStore";

const EmoteCard: Component = () => {
  const [copied, setCopied] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (inspectedEmote()) {
      setCopied(false);
      queueMicrotask(() => dialogRef?.focus());
    }
  });

  const scope = () => {
    emoteRevision();
    const e = inspectedEmote();
    return e ? emoteScopeLabel(e) : undefined;
  };

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
  };

  return (
    <Show when={inspectedEmote()}>
      {(e) => (
        <div class="dialog-backdrop" onMouseDown={closeEmoteCard}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="dialog emote-card"
            role="dialog"
            aria-modal="true"
            aria-label={`${e().code} emote`}
            onMouseDown={(ev) => ev.stopPropagation()}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") closeEmoteCard();
            }}
          >
            <div class="emote-card__preview">
              <img
                src={e().url_4x || e().url_2x || e().url_1x}
                alt={e().code}
                draggable={false}
              />
            </div>
            <div class="emote-card__meta">
              <span class="emote-card__code">{e().code}</span>
              <div class="emote-card__tags">
                <span class={`chip chip--${e().provider}`}>
                  {scope() ?? providerLabel(e().provider)}
                </span>
                <Show when={e().animated}>
                  <span class="chip">Animated</span>
                </Show>
                <Show when={e().zero_width}>
                  <span class="chip">Overlay</span>
                </Show>
              </div>
            </div>
            <div class="card__actions">
              <button
                type="button"
                class="btn btn--small"
                onClick={() => {
                  requestInsert(e().code);
                  closeEmoteCard();
                }}
              >
                Use in chat
              </button>
              <button
                type="button"
                class="btn btn--small"
                onClick={() =>
                  void copy(e().code).catch((err: unknown) =>
                    console.error("copy emote", err),
                  )
                }
              >
                {copied() ? "Copied" : "Copy name"}
              </button>
              <Show when={providerPage(e())}>
                {(url) => (
                  <button
                    type="button"
                    class="btn btn--small"
                    onClick={() =>
                      void openUrl(url()).catch((err: unknown) =>
                        console.error("open emote page", err),
                      )
                    }
                  >
                    Open on {providerLabel(e().provider)}
                  </button>
                )}
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default EmoteCard;
