import type { EmoteMeta } from "../stores/chatStore";
import { settings } from "../stores/settingsStore";

/**
 * The 1x and 2x images to show for `e`: its still frames while animated
 * emotes are switched off, when the provider has them.
 */
export function emoteImages(e: EmoteMeta): { x1: string; x2: string } {
  if (!settings().animatedEmotes && e.static_1x) {
    return { x1: e.static_1x, x2: e.static_2x ?? "" };
  }
  return { x1: e.url_1x, x2: e.url_2x };
}
