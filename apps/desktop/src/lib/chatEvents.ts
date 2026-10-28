// Moderation events from the Rust host (`chat_events`). Mirrors
// `message::ChatEvent` in src-tauri.

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

export type ChatEvent =
  | PublicModerationEvent
  | ModAction
  | HeldMessage
  | HeldMessageResolved;
