// Hover card for an emote in chat: the emote large, its name, the set it
// comes from with the provider's mark, and who made it. Sits above the emote
// and flips below near the top edge. Clicking the emote opens the full card.

import { Component, For, Show } from "solid-js";
import {
  emoteSetName,
  endEmoteHover,
  hoveredEmote,
  largeUrl,
} from "../stores/emoteCardStore";
import HoverTip from "./HoverTip";
import ProviderIcon from "./ProviderIcon";

const EmoteTooltip: Component = () => {
  return (
    <Show when={hoveredEmote()}>
      {(h) => {
        const setName = () => {
          const session = h().pane?.session();
          session?.emotes.revision();
          return emoteSetName(
            h().emote,
            session?.emotes.scopeOf(h().emote),
            session?.channel?.display_name,
          );
        };
        return (
          <HoverTip
            anchor={h().anchor}
            class="emote-tip"
            onDismiss={endEmoteHover}
          >
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
          </HoverTip>
        );
      }}
    </Show>
  );
};

export default EmoteTooltip;
