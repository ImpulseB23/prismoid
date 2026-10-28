// Ads on the signed-in broadcaster's own channel. Mirrors
// src-tauri/src/twitch_ads.rs; every command fails with a ChannelError.

import { invoke } from "@tauri-apps/api/core";

/** Longest commercial Twitch runs, in seconds. */
export const COMMERCIAL_MAX_SECS = 180;

export interface AdSchedule {
  /** Unix ms, like every timestamp here; null when nothing is scheduled or the channel is offline. */
  next_ad_at: number | null;
  /** Null when no ad ran this stream or the channel is offline. */
  last_ad_at: number | null;
  /** Seconds the upcoming ad break lasts. */
  duration: number;
  /** Seconds of pre-roll free time left. */
  preroll_free_time: number;
  snooze_count: number;
  /** When the next snooze is gained. */
  snooze_refresh_at: number | null;
}

export type AdSnooze = Pick<
  AdSchedule,
  "next_ad_at" | "snooze_count" | "snooze_refresh_at"
>;

export interface Commercial {
  /** Seconds requested, capped at 180; Twitch may serve more or less. */
  length: number;
  message: string;
  /** Seconds until another commercial may run. */
  retry_after: number;
}

/** An ad break that began on the user's own channel. */
export interface AdBreak {
  channel_id: string;
  duration_seconds: number;
  started_at: number;
  /** Scheduled by Ads Manager rather than run by hand. */
  is_automatic: boolean;
  /** The broadcaster for automatic ads. */
  requester_id: string;
  requester_login: string;
  requester_name: string;
}

export function getAdSchedule(): Promise<AdSchedule> {
  return invoke("twitch_get_ad_schedule");
}

/** Pushes the next automatic ad back 5 minutes. */
export function snoozeNextAd(): Promise<AdSnooze> {
  return invoke("twitch_snooze_next_ad");
}

/** Runs a commercial of about `length` seconds; the channel must be live. */
export function startCommercial(length: number): Promise<Commercial> {
  return invoke("twitch_start_commercial", { length });
}
