// Twitch sign-in flow client. Mirrors the Tauri command surface in
// apps/desktop/src-tauri/src/twitch_auth/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export type AuthStatusState = "logged_out" | "logged_in";

// Discriminated union: when state is logged_in, login is guaranteed by
// the backend (twitch_auth::commands::twitch_auth_status). Modeling it
// this way prevents the UI from silently rendering an empty username if
// a malformed payload ever slips through.
export type AuthStatus =
  | { state: "logged_out" }
  | {
      state: "logged_in";
      login: string;
      user_id: string;
      /** Scopes the app asks for that the stored grant lacks. */
      missing_scopes: string[];
    };

export interface LoginView {
  /** Twitch authorize URL with the loopback redirect and CSRF state. */
  authorize_url: string;
}

export interface AuthCommandError {
  kind:
    | "no_tokens"
    | "refresh_invalid"
    | "login_timed_out"
    | "login_cancelled"
    | "login_ports_busy"
    | "loopback"
    | "user_denied"
    | "keychain"
    | "oauth"
    | "json"
    | "config"
    | "no_pending_flow";
  message: string;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return invoke("twitch_auth_status");
}

export function startLogin(): Promise<LoginView> {
  return invoke("twitch_start_login");
}

export function completeLogin(): Promise<AuthStatus> {
  return invoke("twitch_complete_login");
}

export function cancelLogin(): Promise<void> {
  return invoke("twitch_cancel_login");
}

export function logout(): Promise<void> {
  return invoke("twitch_logout");
}

const ALLOWED_HOSTS = ["www.twitch.tv", "id.twitch.tv"];

export function openTwitchUrl(uri: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return Promise.reject(new Error("invalid URL"));
  }
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_HOSTS.includes(parsed.hostname)
  ) {
    return Promise.reject(new Error("URL not on a Twitch domain"));
  }
  return openUrl(uri);
}

// Frontend-facing error envelope from sidecar_commands::twitch_send_message.
// Mirrors the discriminated union the Rust side serializes via serde's
// internally-tagged representation. `kind` is stable and safe to switch on.
export type SendMessageError =
  | { kind: "not_logged_in"; message: string }
  | { kind: "empty_message" }
  | { kind: "message_too_long"; max_bytes: number }
  | { kind: "message_too_long_chars"; max_chars: number }
  | { kind: "sidecar_not_running" }
  | { kind: "io"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "json"; message: string }
  | { kind: "helix"; code: string; message: string }
  | { kind: "youtube"; code: string; message: string };

export const MAX_CHAT_MESSAGE_BYTES = 500;

/** Success payload from `twitch_send_message`. Mirrors `SendChatOk`
 * on the Rust side. The `message_id` is the Helix-assigned id, used
 * by the optimistic renderer to correlate a pending entry with its
 * authoritative EventSub echo. */
export interface SendMessageOk {
  message_id: string;
}

// Every command names its channel so a tab switch mid-flight can never
// send a message or a mod action to the wrong room.

export function sendMessage(
  channelId: string,
  text: string,
  replyTo?: string,
): Promise<SendMessageOk> {
  return invoke("twitch_send_message", {
    channelId,
    text,
    replyTo: replyTo ?? null,
  });
}

export function banUser(
  channelId: string,
  targetUserId: string,
  reason?: string,
): Promise<void> {
  return invoke("twitch_ban_user", { channelId, targetUserId, reason });
}

export function unbanUser(
  channelId: string,
  targetUserId: string,
): Promise<void> {
  return invoke("twitch_unban_user", { channelId, targetUserId });
}

export function timeoutUser(
  channelId: string,
  targetUserId: string,
  durationSeconds: number,
  reason?: string,
): Promise<void> {
  return invoke("twitch_timeout_user", {
    channelId,
    targetUserId,
    durationSeconds,
    reason,
  });
}

export function deleteMessage(
  channelId: string,
  messageId: string,
): Promise<void> {
  return invoke("twitch_delete_message", { channelId, messageId });
}
