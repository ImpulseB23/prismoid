// Hover card for an emote in chat: the emote large, its name, the set it
// comes from with the provider's mark, and who made it. Sits above the emote
// and flips below near the top edge. Clicking the emote opens the full card.

import { Component, For, Show, createEffect, onCleanup } from "solid-js";
import {
  emoteSetName,
  endEmoteHover,
  hoveredEmote,
  largeUrl,
} from "../stores/emoteCardStore";
import { emoteRevision, emoteScope } from "../stores/emoteStore";
import { activeChannel } from "../stores/channelStore";
import ProviderIcon from "./ProviderIcon";

const EDGE_GAP = 8;
const ANCHOR_GAP = 8;

const EmoteTooltip: Component = () => {
  let ref: HTMLDivElement | undefined;

  createEffect(() => {
    if (!hoveredEmote()) return;
    window.addEventListener("scroll", endEmoteHover, true);
    window.addEventListener("blur", endEmoteHover);
    window.addEventListener("resize", endEmoteHover);
    onCleanup(() => {
      window.removeEventListener("scroll", endEmoteHover, true);
      window.removeEventListener("blur", endEmoteHover);
      window.removeEventListener("resize", endEmoteHover);
    });
  });

  // Placed once its size is known, before the frame paints.
  createEffect(() => {
    const h = hoveredEmote();
    if (!h || !ref) return;
    const box = ref.getBoundingClientRect();
    const a = h.anchor;
    const above = a.top - box.height - ANCHOR_GAP;
    const top = above >= EDGE_GAP ? above : a.bottom + ANCHOR_GAP;
    const centered = a.left + a.width / 2 - box.width / 2;
    const left = Math.min(
      Math.max(EDGE_GAP, centered),
      window.innerWidth - box.width - EDGE_GAP,
    );
    ref.style.top = `${top}px`;
    ref.style.left = `${left}px`;
    ref.style.visibility = "visible";
  });

  return (
    <Show when={hoveredEmote()}>
      {(h) => {
        const setName = () => {
          emoteRevision();
          return emoteSetName(
            h().emote,
            emoteScope(h().emote),
            activeChannel()?.display_name,
          );
        };
        return (
          <div ref={(el) => (ref = el)} class="emote-tip" role="tooltip">
            <div class="emote-tip__art">
              <img src={largeUrl(h().emote)} alt="" draggable={false} />
              <For each={h().overlays}>
                {(o) => (
                  <img
                    class="emote-tip__overlay"
                    src={largeUrl(o)}
                    alt=""
                    draggable={false}
                  />
                )}
              </For>
            </div>
            <span class="emote-tip__code">
              {[h().emote, ...h().overlays].map((e) => e.code).join(" + ")}
            </span>
            <span class="emote-tip__set">
              <ProviderIcon provider={h().emote.provider} />
              {setName()}
            </span>
            <Show when={h().emote.owner}>
              {(o) => <span class="emote-tip__by">by {o().display_name}</span>}
            </Show>
          </div>
        );
      }}
    </Show>
  );
};

export default EmoteTooltip;
