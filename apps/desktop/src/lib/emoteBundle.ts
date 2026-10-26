// Fetches the bundle the host holds for a channel: on a tab switch, and
// for a webview that mounted after the join (a reload) and missed the event.

import { invoke } from "@tauri-apps/api/core";
import type { EmoteBundle } from "../stores/badgeStore";
import type { EmoteBundleSets } from "../stores/emoteStore";

export function currentEmoteBundle(
  channelId: string,
): Promise<(EmoteBundle & EmoteBundleSets) | null> {
  return invoke("current_emote_bundle", { channelId });
}
