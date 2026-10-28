// Which emote the inspect card is showing, if any, and which one the hover
// tooltip is showing. Set from any emote a message renders; both are
// mounted once in the feed.

import { createSignal } from "solid-js";
import type { EmoteMeta } from "./chatStore";
import type { EmoteScope } from "./emoteStore";
import { preloadImages } from "../lib/preload";
import { getSevenTvUsers, type SevenTvUser } from "../lib/sevenTvUsers";

export interface EmoteHover {
  emote: EmoteMeta;
  overlays: EmoteMeta[];
  anchor: DOMRect;
}

/** Hover intent before the tooltip shows, so sweeping across chat is quiet. */
export const HOVER_DELAY_MS = 150;

const [hoveredEmote, setHoveredEmote] = createSignal<EmoteHover | null>(null);
let hoverSeq = 0;

export { hoveredEmote };

/** The large image the tooltip and card show. */
export const largeUrl = (e: EmoteMeta) => e.url_4x || e.url_2x || e.url_1x;

// Shows once the intent delay has passed and the large image is decoded, so
// the tooltip never appears with an empty picture.
export function hoverEmote(
  el: HTMLElement,
  emote: EmoteMeta,
  overlays: EmoteMeta[],
): void {
  const seq = ++hoverSeq;
  void Promise.all([
    new Promise((r) => setTimeout(r, HOVER_DELAY_MS)),
    preloadImages([emote, ...overlays].map(largeUrl), 400),
  ]).then(() => {
    if (seq !== hoverSeq || !el.isConnected) return;
    setHoveredEmote({ emote, overlays, anchor: el.getBoundingClientRect() });
  });
}

export function endEmoteHover(): void {
  ++hoverSeq;
  setHoveredEmote(null);
}

const [inspectedEmote, setInspectedEmote] = createSignal<EmoteMeta | null>(
  null,
);

export { inspectedEmote };

const [inspectedAddedBy, setInspectedAddedBy] =
  createSignal<SevenTvUser | null>(null);
const [inspectLoading, setInspectLoading] = createSignal<string | null>(null);
let inspectSeq = 0;

export { inspectedAddedBy, inspectLoading };

// Opens once the large image and, for 7TV channel emotes, the name of whoever
// added it are in hand; `inspectLoading` names the emote meanwhile. A failed
// lookup still opens the card, without the name.
export function inspectEmote(emote: EmoteMeta): void {
  endEmoteHover();
  const seq = ++inspectSeq;
  const id = emote.added_by_id;
  setInspectLoading(emote.id);
  const addedBy = id
    ? getSevenTvUsers([id]).then(
        (users) => users.find((u) => u.id === id) ?? null,
        (err: unknown) => {
          console.error("7tv user", err);
          return null;
        },
      )
    : Promise.resolve(null);
  void Promise.all([addedBy, preloadImages([largeUrl(emote)])]).then(([by]) => {
    if (seq !== inspectSeq) return;
    setInspectLoading(null);
    setInspectedAddedBy(by);
    setInspectedEmote(emote);
  });
}

export function closeEmoteCard(): void {
  ++inspectSeq;
  setInspectLoading(null);
  setInspectedAddedBy(null);
  setInspectedEmote(null);
}

const PROVIDER_LABEL: Record<EmoteMeta["provider"], string> = {
  twitch: "Twitch",
  "7tv": "7TV",
  bttv: "BTTV",
  ffz: "FrankerFaceZ",
};

export function providerLabel(provider: EmoteMeta["provider"]): string {
  return PROVIDER_LABEL[provider];
}

/** The emote's page on its provider's site; Twitch has none. */
export function providerPage(emote: EmoteMeta): string | null {
  switch (emote.provider) {
    case "7tv":
      return `https://7tv.app/emotes/${encodeURIComponent(emote.id)}`;
    case "bttv":
      return `https://betterttv.com/emotes/${encodeURIComponent(emote.id)}`;
    case "ffz":
      return `https://www.frankerfacez.com/emoticon/${encodeURIComponent(emote.id)}`;
    case "twitch":
      return null;
  }
}

/** "Forsen's Emotes", "7TV Global", or just the provider when unknown. */
export function emoteSetName(
  emote: EmoteMeta,
  scope: EmoteScope | undefined,
  channel: string | undefined,
): string {
  const provider = PROVIDER_LABEL[emote.provider];
  if (scope === "channel" && channel) return `${channel}'s Emotes`;
  if (scope === "global") return `${provider} Global`;
  return provider;
}
