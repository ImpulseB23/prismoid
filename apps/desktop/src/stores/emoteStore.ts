// Emote catalog for the composer. Rust owns the index that scans incoming
// messages; this store keeps the same bundle on the frontend so the
// composer can complete codes while typing and the picker can browse by
// provider. Channel sets override global ones on duplicate codes, matching
// EmoteIndex::load_bundle.

import { createSignal } from "solid-js";
import type { EmoteMeta } from "./chatStore";

export interface EmoteSet {
  emotes: EmoteMeta[];
}

export interface EmoteBundleSets {
  twitch_global_emotes?: EmoteSet;
  twitch_channel_emotes?: EmoteSet;
  seventv_global?: EmoteSet;
  seventv_channel?: EmoteSet;
  bttv_global?: EmoteSet;
  bttv_channel?: EmoteSet;
  ffz_global?: EmoteSet;
  ffz_channel?: EmoteSet;
}

export interface EmoteGroup {
  label: string;
  emotes: EmoteMeta[];
}

export interface EmoteStore {
  loadBundle: (bundle: EmoteBundleSets) => void;
  /** Every emote currently usable in the channel, sorted by code. */
  all: () => EmoteMeta[];
  /** Non-empty sets in display order: channel sets first, then global. */
  groups: () => EmoteGroup[];
  byCode: (code: string) => EmoteMeta | undefined;
  /** Display label of the set an emote came from ("Channel · 7TV"), if loaded. */
  scopeLabel: (emote: EmoteMeta) => string | undefined;
  revision: () => number;
}

// Load order decides precedence (later wins); display order is separate.
const LOAD_ORDER: (keyof EmoteBundleSets)[] = [
  "twitch_global_emotes",
  "seventv_global",
  "bttv_global",
  "ffz_global",
  "twitch_channel_emotes",
  "seventv_channel",
  "bttv_channel",
  "ffz_channel",
];

const DISPLAY_ORDER: [keyof EmoteBundleSets, string][] = [
  ["twitch_channel_emotes", "Channel · Twitch"],
  ["seventv_channel", "Channel · 7TV"],
  ["bttv_channel", "Channel · BTTV"],
  ["ffz_channel", "Channel · FFZ"],
  ["twitch_global_emotes", "Global · Twitch"],
  ["seventv_global", "Global · 7TV"],
  ["bttv_global", "Global · BTTV"],
  ["ffz_global", "Global · FFZ"],
];

export function createEmoteStore(): EmoteStore {
  let byCode = new Map<string, EmoteMeta>();
  let sorted: EmoteMeta[] = [];
  let groups: EmoteGroup[] = [];
  const [revision, setRevision] = createSignal(0);

  function loadBundle(bundle: EmoteBundleSets): void {
    const next = new Map<string, EmoteMeta>();
    for (const key of LOAD_ORDER) {
      for (const e of bundle[key]?.emotes ?? []) next.set(e.code, e);
    }
    byCode = next;
    sorted = [...next.values()].sort((a, b) => a.code.localeCompare(b.code));
    groups = DISPLAY_ORDER.flatMap(([key, label]) => {
      const emotes = bundle[key]?.emotes ?? [];
      return emotes.length > 0 ? [{ label, emotes }] : [];
    });
    setRevision((r) => r + 1);
  }

  return {
    loadBundle,
    all: () => sorted,
    groups: () => groups,
    byCode: (code) => byCode.get(code),
    scopeLabel: (emote) =>
      groups.find((g) =>
        g.emotes.some(
          (e) => e.id === emote.id && e.provider === emote.provider,
        ),
      )?.label,
    revision,
  };
}

const defaultStore = createEmoteStore();
export const loadEmoteBundle = defaultStore.loadBundle;
export const allEmotes = defaultStore.all;
export const emoteGroups = defaultStore.groups;
export const emoteScopeLabel = defaultStore.scopeLabel;
export const emoteByCode = defaultStore.byCode;
export const emoteRevision = defaultStore.revision;
