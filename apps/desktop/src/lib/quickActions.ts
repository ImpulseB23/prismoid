// Stream manager quick actions on the signed-in broadcaster's own channel.
// Mirrors src-tauri/src/twitch_quick_actions.rs; every command fails with a
// ChannelError, and these kinds are the ones these actions add.

import { invoke } from "@tauri-apps/api/core";
import type { ChannelError } from "./twitchChannel";

export type QuickActionError = Extract<
  ChannelError,
  {
    kind:
      | "not_live"
      | "marker_unavailable"
      | "shoutout_cooldown"
      | "shoutout_needs_viewers"
      | "already_pinned";
  }
>;

/** Twitch limits the host enforces, for counters and form bounds. */
export const QUICK_ACTION_LIMITS = {
  markerDescriptionChars: 140,
  clipDurationSecs: [5, 60],
  clipDefaultSecs: 30,
  announcementChars: 500,
  pinDurationSecs: [30, 1800],
  /** Twitch says a clip still missing after this long failed. */
  clipProcessingMs: 60_000,
} as const;

export interface Marker {
  id: string;
  /** Unix ms, like every timestamp here. */
  created_at: number;
  /** Offset from the start of the stream. */
  position_seconds: number;
  description: string;
}

export interface CreatedClip {
  id: string;
  /** Trim, title and publish here; valid 24 h or until published. */
  edit_url: string;
}

export interface Clip {
  id: string;
  url: string;
  title: string;
  duration: number;
  thumbnail_url: string;
  view_count: number;
  created_at: number;
}

export type AnnouncementColor =
  | "primary"
  | "blue"
  | "green"
  | "orange"
  | "purple";

export interface ShieldMode {
  is_active: boolean;
  /** Who last turned it on; empty if it never was. */
  moderator_id: string;
  moderator_login: string;
  moderator_name: string;
  last_activated_at: number | null;
}

export interface PinnedMessage {
  message_id: string;
  sender_user_id: string;
  sender_user_login: string;
  sender_user_name: string;
  pinned_by_user_id: string;
  pinned_by_user_login: string;
  pinned_by_user_name: string;
  text: string;
  starts_at: number;
  /** null when pinned until the stream ends. */
  ends_at: number | null;
  updated_at: number;
}

/** Marks the current point of the live stream for highlights later. */
export function createMarker(description?: string): Promise<Marker> {
  return invoke("twitch_create_marker", { description: description ?? null });
}

/**
 * Starts a clip of the last seconds of the live stream (30 by default).
 * Twitch finishes it in the background; ask getClip until it shows up.
 */
export function createClip(
  options: { title?: string; duration?: number } = {},
): Promise<CreatedClip> {
  return invoke("twitch_create_clip", {
    title: options.title ?? null,
    duration: options.duration ?? null,
  });
}

/** The finished clip, or null while Twitch is still processing it. */
export function getClip(clipId: string): Promise<Clip | null> {
  return invoke("twitch_get_clip", { clipId });
}

export function sendShoutout(toBroadcasterId: string): Promise<void> {
  return invoke("twitch_send_shoutout", { toBroadcasterId });
}

export function sendAnnouncement(
  message: string,
  color: AnnouncementColor = "primary",
): Promise<void> {
  return invoke("twitch_send_announcement", { message, color });
}

export function getShieldMode(): Promise<ShieldMode> {
  return invoke("twitch_get_shield_mode");
}

export function setShieldMode(isActive: boolean): Promise<ShieldMode> {
  return invoke("twitch_set_shield_mode", { isActive });
}

/** The mod-pinned message, or null when nothing is pinned. */
export function getPinnedMessage(): Promise<PinnedMessage | null> {
  return invoke("twitch_get_pinned_message");
}

/** Pins a message, replacing any pin; without a duration it stays until the stream ends. */
export function pinMessage(
  messageId: string,
  durationSeconds?: number,
): Promise<void> {
  return invoke("twitch_pin_message", {
    messageId,
    durationSeconds: durationSeconds ?? null,
  });
}

export function unpinMessage(messageId: string): Promise<void> {
  return invoke("twitch_unpin_message", { messageId });
}
