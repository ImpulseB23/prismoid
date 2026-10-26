// What the feed and composer show when Twitch refuses to deliver a
// channel's chat to the signed-in user. Twitch hides chat from banned and
// timed-out accounts alike and only answers "not permitted", so the wording
// covers both.

import type { ChatMessage } from "../stores/chatStore";
import type { Channel } from "./twitchChannel";

/** Payload of the host's `chat_banned` event. */
export interface ChatBanned {
  broadcaster_id: string;
  detail: string;
}

export function bannedText(channelName: string): string {
  return `You are banned from talking in ${channelName}.`;
}

export const BANNED_HINT =
  "You can read along, but Twitch won't let you talk here.";

/** System row for a ban that lands while the feed already has messages. */
export function bannedNotice(
  channel: Channel,
  arrivalSeq: number,
): ChatMessage {
  const now = Date.now();
  return {
    id: `banned-${channel.id}-${arrivalSeq}`,
    platform: "Twitch",
    timestamp: now,
    arrival_time: now,
    effective_ts: now,
    arrival_seq: arrivalSeq,
    username: channel.login,
    display_name: channel.display_name,
    platform_user_id: channel.id,
    channel_id: channel.id,
    message_text: "",
    badges: [],
    is_mod: false,
    is_subscriber: false,
    is_broadcaster: false,
    color: null,
    reply_to: null,
    reply_parent: null,
    notice: {
      notice_type: "banned",
      system_message: bannedText(channel.display_name),
    },
    emote_spans: [],
  };
}
