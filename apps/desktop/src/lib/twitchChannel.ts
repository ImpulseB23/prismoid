// Channel selection client. Mirrors apps/desktop/src-tauri/src/twitch_channel.rs.

import { invoke } from "@tauri-apps/api/core";

export interface Channel {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export type ChannelError =
  | { kind: "not_logged_in"; message: string }
  | { kind: "invalid_login" }
  | { kind: "not_found"; login: string }
  | { kind: "auth"; message: string }
  | { kind: "http"; message: string }
  | { kind: "helix"; status: number; message: string }
  | { kind: "invalid_setting"; message: string };

/** Opens a channel as a tab and shows it. */
export function joinChannel(login: string): Promise<Channel> {
  return invoke("twitch_join_channel", { login });
}

export function leaveChannel(channelId: string): Promise<void> {
  return invoke("twitch_leave_channel", { channelId });
}

/** Shows an open tab. Resolves false when the host does not know the id. */
export function focusChannel(channelId: string): Promise<boolean> {
  return invoke("twitch_focus_channel", { channelId });
}

/** Reconnects one channel's chat, for checking a ban or timeout. */
export function rejoinChannel(channelId: string): Promise<void> {
  return invoke("twitch_rejoin_channel", { channelId });
}

export function getChannel(): Promise<Channel | null> {
  return invoke("twitch_get_channel");
}

export function isChannelError(e: unknown): e is ChannelError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

export function formatChannelError(e: unknown): string {
  if (!isChannelError(e)) {
    return e instanceof Error ? e.message : String(e);
  }
  switch (e.kind) {
    case "invalid_login":
      return "Enter a Twitch username: letters, numbers and underscores only.";
    case "not_found":
      return `No Twitch channel named "${e.login}".`;
    case "not_logged_in":
      return "Sign in to Twitch to pick a channel.";
    case "http":
      return "Could not reach Twitch. Check your connection and try again.";
    case "helix":
      if (e.status === 401)
        return "Twitch rejected the session. Sign out and back in.";
      if (e.status === 403) return "Twitch says you cannot do that here.";
      return `Twitch returned an error (${e.status}).`;
    case "auth":
    case "invalid_setting":
      return e.message;
  }
}

export interface ChatSettings {
  emote_mode: boolean;
  follower_mode: boolean;
  /** Minutes a follow must be old to chat; null when off. */
  follower_mode_duration: number | null;
  slow_mode: boolean;
  /** Seconds between messages; null when off. */
  slow_mode_wait_time: number | null;
  subscriber_mode: boolean;
  unique_chat_mode: boolean;
  non_moderator_chat_delay: boolean;
  non_moderator_chat_delay_duration: number | null;
}

/** Send only the fields being changed; a duration needs its mode set true. */
export type ChatSettingsPatch = Partial<ChatSettings>;

export function getChatSettings(
  channelId: string,
): Promise<ChatSettings | null> {
  return invoke("twitch_get_chat_settings", { channelId });
}

export function updateChatSettings(
  channelId: string,
  patch: ChatSettingsPatch,
): Promise<ChatSettings> {
  return invoke("twitch_update_chat_settings", { channelId, patch });
}

// Same rule as `normalize_login` on the Rust side, kept here so the picker
// can reject obvious typos before a round trip.
export function normalizeLogin(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^@/, "");
  return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
}

/**
 * Whether a message belongs in the view for `activeChannelId`. Twitch
 * messages are tagged with their broadcaster id and anything from another
 * room is a straggler from before a switch. Other platforms have a single
 * connection and pass through. With no active channel yet, nothing is
 * known, so everything passes.
 */
export function isForChannel(
  msg: { platform: string; channel_id: string },
  activeChannelId: string | undefined,
): boolean {
  if (msg.platform !== "Twitch" || activeChannelId === undefined) return true;
  return msg.channel_id === activeChannelId;
}

export interface ChannelSearchResult {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  is_live: boolean;
  game_name: string;
  title: string;
  viewer_count: number | null;
  followers: number | null;
  /** The signed-in user follows this channel. */
  followed: boolean;
}

/** Helix prefix search over channels that streamed in the last six months. */
export function searchChannels(query: string): Promise<ChannelSearchResult[]> {
  return invoke("twitch_search_channels", { query });
}

export interface FollowedLive {
  id: string;
  login: string;
  display_name: string;
  game_name: string;
  viewer_count: number;
}

/**
 * Followed channels live now, the ones the user chats in most first and
 * the rest by viewers.
 */
export function getFollowedLive(): Promise<FollowedLive[]> {
  return invoke("twitch_followed_live");
}

export interface StreamInfo {
  is_live: boolean;
  title: string;
  game_name: string;
  viewer_count: number | null;
  started_at: string | null;
}

/** Live state and title for the active channel; null with no channel. */
export function getStreamInfo(channelId: string): Promise<StreamInfo | null> {
  return invoke("twitch_get_stream_info", { channelId });
}

/** Resolves a login to its id and display name. */
export function lookupUser(login: string): Promise<Channel> {
  return invoke("twitch_lookup_user", { login });
}

export interface ModeratedChannel {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
}

/** Channels where the signed-in user holds the moderator role. */
export function getModeratedChannels(): Promise<ModeratedChannel[]> {
  return invoke("twitch_moderated_channels");
}

export interface UserInfo {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  description: string;
  /** RFC 3339 account creation time. */
  created_at: string;
}

/** Public profiles for up to a few hundred user ids; batched on the host. */
export function getUsersInfo(ids: string[]): Promise<UserInfo[]> {
  return invoke("twitch_users_info", { ids });
}
