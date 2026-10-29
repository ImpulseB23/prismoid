// Opens when an emote in a message is clicked: the emote large, its name and
// creator, where it comes from, and ways to use it or look it up.

import { Component, Show, createEffect, createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  closeEmoteCard,
  emoteSetName,
  inspectedAddedBy,
  inspectedEmote,
  inspectedPane,
  largeUrl,
  providerLabel,
  providerPage,
} from "../stores/emoteCardStore";
import ProviderIcon from "./ProviderIcon";

const EmoteCard: Component = () => {
  const [copied, setCopied] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (inspectedEmote()) {
      setCopied(false);
      queueMicrotask(() => dialogRef?.focus());
    }
  });

  const setName = () => {
    const session = inspectedPane()?.session();
    session?.emotes.revision();
    const e = inspectedEmote();
    return e
      ? emoteSetName(
          e,
          session?.emotes.scopeOf(e),
          session?.channel?.display_name,
        )
      : "";
  };

  // "by xQc · 26 May 2021", or just the date when 7TV did not name them.
  const added = (at: number) => {
    const date = new Date(at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const by = inspectedAddedBy();
    return by ? `by ${by.display_name} · ${date}` : date;
  };

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
  };

  return (
    <Show when={inspectedEmote()}>
      {(e) => {
        const kind = () =>
          [
            e().animated ? "Animated" : "Static",
            e().zero_width ? "overlay" : "",
          ]
            .filter(Boolean)
            .join(", ");
        return (
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
              <div class="emote-card__hero">
                <img src={largeUrl(e())} alt={e().code} draggable={false} />
                <button
                  type="button"
                  class="icon-btn emote-card__close"
                  aria-label="Close"
                  onClick={closeEmoteCard}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 2l8 8M10 2l-8 8"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
              <div class="emote-card__head">
                <span class="emote-card__code">{e().code}</span>
                <Show when={e().owner}>
                  {(o) => (
                    <span class="emote-card__by">by {o().display_name}</span>
                  )}
                </Show>
              </div>
              <dl class="emote-card__facts">
                <dt>From</dt>
                <dd>
                  <ProviderIcon provider={e().provider} />
                  {setName()}
                </dd>
                <dt>Type</dt>
                <dd>{kind()}</dd>
                <Show when={e().added_at}>
                  {(at) => (
                    <>
                      <dt>Added</dt>
                      <dd>{added(at())}</dd>
                    </>
                  )}
                </Show>
              </dl>
              <div class="emote-card__actions">
                <button
                  type="button"
                  class="btn btn--small btn--primary"
                  onClick={() => {
                    inspectedPane()?.composer.requestInsert(e().code);
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
                      class="emote-card__link"
                      onClick={() =>
                        void openUrl(url()).catch((err: unknown) =>
                          console.error("open emote page", err),
                        )
                      }
                    >
                      {providerLabel(e().provider)}
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                      >
                        <path
                          d="M3.5 1.5h5v5M8.5 1.5 2 8"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.3"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </Show>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default EmoteCard;
