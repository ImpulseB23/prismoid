// What the line under the chat box says: room left in the message, and how
// long until slow mode or a timeout lets the user send again.

import { MAX_CHAT_MESSAGE_BYTES } from "./twitchAuth";
import type { ModAction } from "./chatEvents";
import type { ChatSettings } from "./twitchChannel";

/** The counter shows once a message is within this many bytes of the cap. */
export const COUNTER_FROM = 100;

const encoder = new TextEncoder();

export function bytesLeft(text: string): number {
  return MAX_CHAT_MESSAGE_BYTES - encoder.encode(text.trim()).byteLength;
}

/** Seconds until slow mode allows the next message; mods and the streamer are exempt. */
export function slowModeLeft(
  settings: ChatSettings | null,
  lastSentAt: number | undefined,
  now: number,
  exempt: boolean,
): number {
  if (exempt || !settings?.slow_mode || lastSentAt === undefined) return 0;
  const wait = settings.slow_mode_wait_time ?? 0;
  return Math.max(0, Math.ceil(wait - (now - lastSentAt) / 1000));
}

/** Seconds left on the user's latest timeout in the channel, 0 once it ran out or was lifted. */
export function timeoutLeft(
  actions: ModAction[],
  channelId: string,
  now: number,
): number {
  let latest: ModAction | undefined;
  for (const a of actions) {
    if (a.channel_id !== channelId) continue;
    if (
      a.action !== "timeout" &&
      a.action !== "untimeout" &&
      a.action !== "unban"
    )
      continue;
    if (!latest || a.timestamp > latest.timestamp) latest = a;
  }
  if (latest?.action !== "timeout" || !latest.duration_seconds) return 0;
  const end = latest.timestamp + latest.duration_seconds * 1000;
  return Math.max(0, Math.ceil((end - now) / 1000));
}
