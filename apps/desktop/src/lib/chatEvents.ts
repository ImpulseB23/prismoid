// Moderation events from the Rust host (`chat_events`). Mirrors
// `message::ChatEvent` in src-tauri.

import type { AdBreak } from "./ads";
import type { Poll, Prediction } from "./streamManager";
import type { ChatSettings } from "./twitchChannel";

export interface ModAction {
  kind: "mod_action";
  channel_id: string;
  timestamp: number;
  moderator_login: string;
  moderator_name: string;
  /** Twitch's verb: timeout, ban, unban, delete, slow, followers, vip, warn, ... */
  action: string;
  target_user_id: string;
  target_user_login: string;
  target_user_name: string;
  reason: string;
  duration_seconds: number | null;
  message_id: string;
  message_body: string;
  wait_time_seconds: number | null;
  follow_duration_minutes: number | null;
  viewer_count: number | null;
  terms: string[];
  moderator_message: string;
}

export interface HeldMessage {
  kind: "automod_held";
  channel_id: string;
  message_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  text: string;
  /** automod, blocked_term or blocked_link */
  reason: string;
  /** Only set when reason is automod. */
  category: string;
  level: number | null;
  held_at: number;
}

export interface HeldMessageResolved {
  kind: "automod_resolved";
  channel_id: string;
  message_id: string;
  status: "approved" | "denied" | "expired";
  moderator_login: string;
  moderator_name: string;
}

/** What Twitch tells every viewer about a moderation event. */
export type PublicModerationEvent =
  | {
      kind: "message_deleted";
      channel_id: string;
      message_id: string;
      target_user_id: string;
    }
  | {
      kind: "user_cleared";
      channel_id: string;
      target_user_id: string;
      target_user_login: string;
      target_user_name: string;
    }
  | { kind: "chat_cleared"; channel_id: string };

/**
 * Payload of the host's `user_clear` event, read from Twitch IRC since
 * EventSub leaves it out for viewers: a cleared user's timeout length, or
 * null for a ban.
 */
export interface UserClear {
  channel_id: string;
  target_user_id: string;
  duration_seconds: number | null;
}

/** The channel raided another; `channel_id` is the raiding channel. */
export interface RaidEvent {
  kind: "raid";
  channel_id: string;
  to_user_id: string;
  to_user_login: string;
  to_user_name: string;
  viewers: number;
}

/** A poll on the user's own channel began, got votes or ended. */
export type PollUpdate = Poll & { kind: "poll_update" };

/** A prediction on the user's own channel changed. */
export type PredictionUpdate = Prediction & { kind: "prediction_update" };

/** An ad break began on the user's own channel. */
export type AdBreakEvent = AdBreak & { kind: "ad_break" };

/**
 * The room's modes changed. Every chatter gets it; the non-moderator delay
 * is not part of it.
 */
export type ChatSettingsUpdate = Omit<
  ChatSettings,
  "non_moderator_chat_delay" | "non_moderator_chat_delay_duration"
> & { kind: "chat_settings"; channel_id: string };

export type ChatEvent =
  | ChatSettingsUpdate
  | PublicModerationEvent
  | ModAction
  | HeldMessage
  | HeldMessageResolved
  | PollUpdate
  | PredictionUpdate
  | AdBreakEvent
  | RaidEvent;
