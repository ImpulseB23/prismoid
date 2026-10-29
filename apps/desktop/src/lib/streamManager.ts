// Stream manager client for the signed-in broadcaster's own channel.
// Mirrors src-tauri/src/twitch_channel_info.rs and twitch_polls.rs; every
// command acts on the user's own channel and fails with a ChannelError.

import { invoke } from "@tauri-apps/api/core";

/** Twitch limits the host enforces, for counters and form bounds. */
export const LIMITS = {
  titleChars: 140,
  tags: 10,
  tagChars: 25,
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
  /** ISO 639-1 code, or "other". */
  broadcaster_language: string;
  tags: string[];
  /** Label ids in effect, the ones the category implies included. */
  content_classification_labels: string[];
  is_branded_content: boolean;
}

export interface LabelSetting {
  id: string;
  is_enabled: boolean;
}

/**
 * Send only what changes. An empty game_id clears the category, an empty
 * tags list clears the tags, and labels left out keep their state.
 */
export interface ChannelInfoUpdate {
  title?: string;
  game_id?: string;
  broadcaster_language?: string;
  /** Letters and numbers only, see LIMITS for the counts. */
  tags?: string[];
  content_classification_labels?: LabelSetting[];
  is_branded_content?: boolean;
}

export interface Category {
  id: string;
  name: string;
  box_art_url: string;
}

export interface ContentLabel {
  id: string;
  name: string;
  description: string;
}

/**
 * Stream language choices: every ISO 639-1 code (Library of Congress
 * registry) plus "other". Twitch documents the codes but not which ones it
 * supports, and skips an unsupported one, which the host reports as
 * language_not_supported. Show names with Intl.DisplayNames.
 */
// spellchecker:off
export const STREAM_LANGUAGES = (
  "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch " +
  "co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy " +
  "ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it " +
  "iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo " +
  "lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny " +
  "oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl " +
  "sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty " +
  "ug uk ur uz ve vi vo wa wo xh yi yo za zh zu other"
).split(" ");
// spellchecker:on

// The locales the Get Content Classification Labels reference lists. It
// also lists "pt-BT", which matches no real locale, so Brazilian
// Portuguese falls back to pt-PT.
const LABEL_LOCALES = [
  "bg-BG",
  "cs-CZ",
  "da-DK",
  "de-DE",
  "el-GR",
  "en-GB",
  "en-US",
  "es-ES",
  "es-MX",
  "fi-FI",
  "fr-FR",
  "hu-HU",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "nl-NL",
  "no-NO",
  "pl-PL",
  "pt-PT",
  "ro-RO",
  "ru-RU",
  "sk-SK",
  "sv-SE",
  "th-TH",
  "tr-TR",
  "vi-VN",
  "zh-CN",
  "zh-TW",
];

/**
 * The label locale closest to the user's languages (navigator.languages):
 * an exact match, else the first one sharing the language, else en-US.
 */
export function labelLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    const exact = LABEL_LOCALES.find(
      (l) => l.toLowerCase() === tag.toLowerCase(),
    );
    if (exact) return exact;
    const lang = tag.split("-")[0].toLowerCase();
    const same = LABEL_LOCALES.find((l) => l.startsWith(`${lang}-`));
    if (same) return same;
  }
  return "en-US";
}

/**
 * The label changes that turn `current` (ids from ChannelInfo) into
 * `enabled`; null when nothing changes.
 */
export function labelChanges(
  current: readonly string[],
  enabled: readonly string[],
): LabelSetting[] | null {
  const changes = [
    ...enabled
      .filter((id) => !current.includes(id))
      .map((id) => ({ id, is_enabled: true })),
    ...current
      .filter((id) => !enabled.includes(id))
      .map((id) => ({ id, is_enabled: false })),
  ];
  return changes.length > 0 ? changes : null;
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

/** Every content label, named and described for `locale` (see labelLocale). */
export function getContentLabels(locale: string): Promise<ContentLabel[]> {
  return invoke("twitch_get_content_labels", { locale });
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
