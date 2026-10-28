// Room mode switches shared by the mod bar and the modes panel: what each
// switch sends to Twitch when flipped, and how an active mode is labelled.

import type { ChatSettings, ChatSettingsPatch } from "./twitchChannel";

export type ChatMode =
  | "slow"
  | "followers"
  | "subscriber"
  | "emote"
  | "unique"
  | "delay";

/** Flipping a mode on uses the same defaults the Twitch dashboard does. */
export function patchFor(mode: ChatMode, on: boolean): ChatSettingsPatch {
  switch (mode) {
    case "emote":
      return { emote_mode: on };
    case "subscriber":
      return { subscriber_mode: on };
    case "unique":
      return { unique_chat_mode: on };
    case "slow":
      return on
        ? { slow_mode: true, slow_mode_wait_time: 30 }
        : { slow_mode: false };
    case "followers":
      return on
        ? { follower_mode: true, follower_mode_duration: 0 }
        : { follower_mode: false };
    case "delay":
      return on
        ? {
            non_moderator_chat_delay: true,
            non_moderator_chat_delay_duration: 2,
          }
        : { non_moderator_chat_delay: false };
  }
}

export function isOn(s: ChatSettings, mode: ChatMode): boolean {
  switch (mode) {
    case "emote":
      return s.emote_mode;
    case "subscriber":
      return s.subscriber_mode;
    case "unique":
      return s.unique_chat_mode;
    case "slow":
      return s.slow_mode;
    case "followers":
      return s.follower_mode;
    case "delay":
      return s.non_moderator_chat_delay;
  }
}

/** Short label for a chip, with the duration when the mode has one. */
export function chipLabel(s: ChatSettings | null, mode: ChatMode): string {
  switch (mode) {
    case "slow":
      return s?.slow_mode && s.slow_mode_wait_time
        ? `Slow ${s.slow_mode_wait_time}s`
        : "Slow";
    case "followers":
      return s?.follower_mode && s.follower_mode_duration
        ? `Followers ${formatMinutes(s.follower_mode_duration)}`
        : "Followers";
    case "subscriber":
      return "Subs";
    case "emote":
      return "Emotes";
    case "unique":
      return "Unique";
    case "delay":
      return s?.non_moderator_chat_delay && s.non_moderator_chat_delay_duration
        ? `Delay ${s.non_moderator_chat_delay_duration}s`
        : "Delay";
  }
}

function formatMinutes(min: number): string {
  if (min % 43_200 === 0) return `${min / 43_200}mo`;
  if (min % 10_080 === 0) return `${min / 10_080}w`;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}
