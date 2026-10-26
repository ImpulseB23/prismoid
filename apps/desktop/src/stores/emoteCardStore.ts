// Which emote the inspect card is showing, if any. Set by clicking an emote
// anywhere a message renders; the card itself is mounted once in the feed.

import { createSignal } from "solid-js";
import type { EmoteMeta } from "./chatStore";

const [inspectedEmote, setInspectedEmote] = createSignal<EmoteMeta | null>(
  null,
);

export { inspectedEmote };

export function inspectEmote(emote: EmoteMeta): void {
  setInspectedEmote(emote);
}

export function closeEmoteCard(): void {
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
