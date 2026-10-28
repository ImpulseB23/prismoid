// Stream manager client for the signed-in broadcaster's own channel.
// Mirrors src-tauri/src/twitch_channel_info.rs and twitch_polls.rs; every
// command acts on the user's own channel and fails with a ChannelError.

import { invoke } from "@tauri-apps/api/core";

/** Twitch limits the host enforces, for counters and form bounds. */
export const LIMITS = {
  titleChars: 140,
  pollTitleChars: 60,
  pollChoiceChars: 25,
  pollChoices: [2, 5],
  pollDurationSecs: [15, 1800],
  pollPointsPerVote: [1, 1_000_000],
  predictionTitleChars: 45,
  predictionOutcomeChars: 25,
  predictionOutcomes: [2, 10],
  predictionWindowSecs: [30, 1800],
} as const;

export interface ChannelInfo {
  broadcaster_id: string;
  title: string;
  /** Empty when no category is set. */
  game_id: string;
  game_name: string;
}

/** Send only what changes; an empty game_id clears the category. */
export interface ChannelInfoUpdate {
  title?: string;
  game_id?: string;
}

export interface Category {
  id: string;
  name: string;
  box_art_url: string;
}

export interface PollChoice {
  id: string;
  title: string;
  /** Every vote, Channel Points ones included. */
  votes: number;
  channel_points_votes: number;
}

export type PollStatus =
  | "active"
  | "completed"
  | "terminated"
  | "archived"
  | "moderated"
  | "invalid";

export interface Poll {
  id: string;
  channel_id: string;
  title: string;
  choices: PollChoice[];
  channel_points_voting_enabled: boolean;
  channel_points_per_vote: number;
  status: PollStatus;
  /** Unix ms, like every timestamp here. */
  started_at: number;
  /** Scheduled end; null on an end notification. */
  ends_at: number | null;
  ended_at: number | null;
}

export interface NewPoll {
  title: string;
  choices: string[];
  duration: number;
  /** Extra votes for this many Channel Points each; null for none. */
  channel_points_per_vote: number | null;
}

export interface PredictionOutcome {
  id: string;
  title: string;
  color: "blue" | "pink";
  users: number;
  channel_points: number;
}

export type PredictionStatus = "active" | "locked" | "resolved" | "canceled";

export interface Prediction {
  id: string;
  channel_id: string;
  title: string;
  outcomes: PredictionOutcome[];
  status: PredictionStatus;
  winning_outcome_id: string | null;
  started_at: number;
  /** When the window closes; null on lock and end notifications. */
  locks_at: number | null;
  locked_at: number | null;
  ended_at: number | null;
}

export interface NewPrediction {
  title: string;
  outcomes: string[];
  prediction_window: number;
}

export function getChannelInfo(): Promise<ChannelInfo | null> {
  return invoke("twitch_get_channel_info");
}

/** Applies the change and resolves with the channel as Twitch now has it. */
export function updateChannelInfo(
  update: ChannelInfoUpdate,
): Promise<ChannelInfo> {
  return invoke("twitch_update_channel_info", { update });
}

/** Categories whose name contains every word of the query. */
export function searchCategories(query: string): Promise<Category[]> {
  return invoke("twitch_search_categories", { query });
}

/** The latest poll, running or not; null if there never was one. */
export function getPoll(): Promise<Poll | null> {
  return invoke("twitch_get_poll");
}

export function createPoll(poll: NewPoll): Promise<Poll> {
  return invoke("twitch_create_poll", { poll });
}

/** Ends a running poll early; archive also hides it from the channel. */
export function endPoll(pollId: string, archive: boolean): Promise<Poll> {
  return invoke("twitch_end_poll", { pollId, archive });
}

/** The latest prediction, running or not; null if there never was one. */
export function getPrediction(): Promise<Prediction | null> {
  return invoke("twitch_get_prediction");
}

export function createPrediction(
  prediction: NewPrediction,
): Promise<Prediction> {
  return invoke("twitch_create_prediction", { prediction });
}

export function lockPrediction(predictionId: string): Promise<Prediction> {
  return invoke("twitch_lock_prediction", { predictionId });
}

export function resolvePrediction(
  predictionId: string,
  winningOutcomeId: string,
): Promise<Prediction> {
  return invoke("twitch_resolve_prediction", {
    predictionId,
    winningOutcomeId,
  });
}

/** Ends the prediction and refunds every viewer. */
export function cancelPrediction(predictionId: string): Promise<Prediction> {
  return invoke("twitch_cancel_prediction", { predictionId });
}
