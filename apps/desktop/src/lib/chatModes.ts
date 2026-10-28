// Room mode switches for the modes panel: what each switch sends to Twitch
// when flipped, and how the active modes read on the mod bar.

import type { ChatSettings, ChatSettingsPatch } from "./twitchChannel";

/** Slow mode waits offered in the panel and Settings, in seconds. */
export const SLOW_CHOICES = [3, 5, 10, 30, 60, 120];
/** Follow ages offered for followers-only chat, in minutes. */
export const FOLLOWER_CHOICES: [label: string, minutes: number][] = [
  ["Any follower", 0],
  ["10 minutes", 10],
  ["30 minutes", 30],
  ["1 hour", 60],
  ["1 day", 1440],
  ["1 week", 10_080],
  ["1 month", 43_200],
];

export type ChatMode =
  | "slow"
  | "followers"
  | "subscriber"
  | "emote"
  | "unique"
  | "delay";

/** The durations a mode switches on with, chosen in setup and Settings. */
export interface ModeDefaults {
  slowSeconds: number;
  followerMinutes: number;
}

export function patchFor(
  mode: ChatMode,
  on: boolean,
  defaults: ModeDefaults,
): ChatSettingsPatch {
  switch (mode) {
    case "emote":
      return { emote_mode: on };
    case "subscriber":
      return { subscriber_mode: on };
    case "unique":
      return { unique_chat_mode: on };
    case "slow":
      return on
        ? { slow_mode: true, slow_mode_wait_time: defaults.slowSeconds }
        : { slow_mode: false };
    case "followers":
      return on
        ? {
            follower_mode: true,
            follower_mode_duration: defaults.followerMinutes,
          }
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

/** Short label for an active mode, with its duration when it has one. */
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

const ALL_MODES: ChatMode[] = [
  "slow",
  "followers",
  "subscriber",
  "emote",
  "unique",
  "delay",
];

/** "Slow 5s, Subs" for the modes that are on, or null when chat is open. */
export function activeSummary(s: ChatSettings | null): string | null {
  if (!s) return null;
  const on = ALL_MODES.filter((m) => isOn(s, m)).map((m) => chipLabel(s, m));
  return on.length > 0 ? on.join(", ") : null;
}
