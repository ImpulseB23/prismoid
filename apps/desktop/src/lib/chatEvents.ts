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

export type ChatEvent =
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
  | { kind: "chat_cleared"; channel_id: string }
  | ModAction;
