// Turns a channel.moderate event into the one-line notice moderators see
// in the feed and in a user's history, and into a feed row.

import type { ModAction, PublicModerationEvent, UserClear } from "./chatEvents";
import type { ChatMessage } from "../stores/chatStore";
import { formatSeconds } from "./slashCommands";
import { formatViewers } from "./streamInfo";

function who(a: ModAction): string {
  return a.moderator_name || a.moderator_login || "A moderator";
}

function target(a: ModAction): string {
  return a.target_user_name || a.target_user_login || "a user";
}

function withReason(line: string, reason: string): string {
  return reason ? `${line}: ${reason}` : line;
}

export function describeModAction(a: ModAction): string {
  const mod = who(a);
  const user = target(a);
  switch (a.action) {
    case "timeout":
    case "shared_chat_timeout":
      return withReason(
        `${mod} timed out ${user}${a.duration_seconds !== null ? ` for ${formatSeconds(a.duration_seconds)}` : ""}`,
        a.reason,
      );
    case "untimeout":
    case "shared_chat_untimeout":
      return `${mod} lifted the timeout on ${user}`;
    case "ban":
    case "shared_chat_ban":
      return withReason(`${mod} banned ${user}`, a.reason);
    case "unban":
    case "shared_chat_unban":
      return `${mod} unbanned ${user}`;
    case "delete":
    case "shared_chat_delete":
      return a.message_body
        ? `${mod} deleted a message from ${user}: ${a.message_body}`
        : `${mod} deleted a message from ${user}`;
    case "warn":
      return withReason(`${mod} warned ${user}`, a.reason);
    case "clear":
      return `${mod} cleared chat`;
    case "slow":
      return `${mod} turned on slow mode${a.wait_time_seconds !== null ? ` (${formatSeconds(a.wait_time_seconds)})` : ""}`;
    case "slowoff":
      return `${mod} turned off slow mode`;
    case "followers":
      return `${mod} turned on followers-only${a.follow_duration_minutes ? ` (${formatSeconds(a.follow_duration_minutes * 60)})` : ""}`;
    case "followersoff":
      return `${mod} turned off followers-only`;
    case "emoteonly":
      return `${mod} turned on emote-only`;
    case "emoteonlyoff":
      return `${mod} turned off emote-only`;
    case "subscribers":
      return `${mod} turned on subscribers-only`;
    case "subscribersoff":
      return `${mod} turned off subscribers-only`;
    case "uniquechat":
      return `${mod} turned on unique-chat`;
    case "uniquechatoff":
      return `${mod} turned off unique-chat`;
    case "raid":
      return `${mod} started a raid to ${user}${a.viewer_count !== null ? ` with ${formatViewers(a.viewer_count)} viewers` : ""}`;
    case "unraid":
      return `${mod} cancelled the raid`;
    case "mod":
      return `${mod} made ${user} a moderator`;
    case "unmod":
      return `${mod} removed ${user} as moderator`;
    case "vip":
      return `${mod} made ${user} a VIP`;
    case "unvip":
      return `${mod} removed ${user} as VIP`;
    case "add_blocked_term":
      return `${mod} blocked ${quoted(a.terms)}`;
    case "remove_blocked_term":
      return `${mod} unblocked ${quoted(a.terms)}`;
    case "add_permitted_term":
      return `${mod} permitted ${quoted(a.terms)}`;
    case "remove_permitted_term":
      return `${mod} removed permitted ${quoted(a.terms)}`;
    case "approve_unban_request":
      return withReason(
        `${mod} approved an unban request from ${user}`,
        a.moderator_message,
      );
    case "deny_unban_request":
      return withReason(
        `${mod} denied an unban request from ${user}`,
        a.moderator_message,
      );
    default:
      return `${mod} performed ${a.action.replace(/_/g, " ")}`;
  }
}

function quoted(terms: string[]): string {
  if (terms.length === 0) return "a term";
  return terms.map((t) => `"${t}"`).join(", ");
}

/** Rows for bans and timeouts carry their own notice type for the colour. */
function noticeTypeOf(action: string): string {
  switch (action) {
    case "ban":
    case "shared_chat_ban":
      return "ban";
    case "timeout":
    case "shared_chat_timeout":
      return "timeout";
    default:
      return "mod_action";
  }
}

/**
 * The notice for a user whose messages were cleared, as a viewer knows it.
 * Without `clear` only the clear itself is known; with it, Twitch IRC said
 * whether it was a ban or a timeout and how long. Never who or why: Twitch
 * keeps those for moderators.
 */
export function userClearedNotice(
  name: string,
  clear?: UserClear,
): { notice_type: string; system_message: string } {
  if (!clear) {
    return {
      notice_type: "mod_action",
      system_message: `${name} was timed out or banned`,
    };
  }
  if (clear.duration_seconds === null) {
    return { notice_type: "ban", system_message: `${name} was banned` };
  }
  return {
    notice_type: "timeout",
    system_message: `${name} was timed out for ${formatSeconds(clear.duration_seconds)}`,
  };
}

/**
 * What a non-moderator can know about a moderation event. Twitch only
 * sends these channels the effect: a user's messages gone, one message
 * gone, or the whole chat, with no moderator or reason.
 */
export function describePublicModeration(
  e: PublicModerationEvent,
  deleted?: { display_name: string; message_text: string },
): string {
  switch (e.kind) {
    case "user_cleared":
      return userClearedNotice(clearedName(e)).system_message;
    case "message_deleted":
      return deleted
        ? `A message from ${deleted.display_name} was deleted: ${deleted.message_text}`
        : "A message was deleted";
    case "chat_cleared":
      return "Chat was cleared";
  }
}

function clearedName(e: {
  target_user_name: string;
  target_user_login: string;
}) {
  return e.target_user_name || e.target_user_login || "A user";
}

/**
 * Feed row for a moderation event seen without the moderator feed. A
 * cleared user's row says ban or timeout when `clear` has already come.
 */
export function publicModerationMessage(
  e: PublicModerationEvent,
  arrivalSeq: number,
  deleted?: { display_name: string; message_text: string },
  clear?: UserClear,
): ChatMessage {
  const now = Date.now();
  const target = e.kind === "user_cleared" ? e : null;
  return {
    id: `mod-${now}-${arrivalSeq}`,
    platform: "Twitch",
    timestamp: now,
    arrival_time: now,
    effective_ts: now,
    arrival_seq: arrivalSeq,
    username: target?.target_user_login ?? "",
    display_name: target?.target_user_name ?? "",
    platform_user_id: e.kind === "chat_cleared" ? "" : e.target_user_id,
    channel_id: e.channel_id,
    message_text: "",
    badges: [],
    is_mod: false,
    is_subscriber: false,
    is_broadcaster: false,
    color: null,
    reply_to: null,
    reply_parent: null,
    notice:
      e.kind === "user_cleared"
        ? userClearedNotice(clearedName(e), clear)
        : {
            notice_type: "mod_action",
            system_message: describePublicModeration(e, deleted),
          },
    emote_spans: [],
  };
}

/** Feed row for a moderator action; renders through the notice path. */
export function modActionMessage(
  a: ModAction,
  arrivalSeq: number,
): ChatMessage {
  const now = Date.now();
  return {
    id: `mod-${a.timestamp}-${arrivalSeq}`,
    platform: "Twitch",
    timestamp: a.timestamp,
    arrival_time: now,
    effective_ts: now,
    arrival_seq: arrivalSeq,
    username: a.target_user_login,
    display_name: a.target_user_name,
    platform_user_id: a.target_user_id,
    channel_id: a.channel_id,
    message_text: "",
    badges: [],
    is_mod: false,
    is_subscriber: false,
    is_broadcaster: false,
    color: null,
    reply_to: null,
    reply_parent: null,
    notice: {
      notice_type: noticeTypeOf(a.action),
      system_message: describeModAction(a),
    },
    emote_spans: [],
  };
}

const CLEAR_PAIR_MS = 10_000;

/**
 * Pairs a viewer's cleared-user row (EventSub) with how the user was
 * removed (Twitch IRC). They come on separate connections in either order:
 * `take` hands over a clear that came first, `wait` remembers a row still
 * missing one, and `arrive` returns that row's id or keeps the clear for
 * the row to come. Anything unpaired after ten seconds is dropped.
 */
export function createClearPairing(now: () => number = Date.now) {
  const rows = new Map<string, { id: string; at: number }>();
  const clears = new Map<string, { clear: UserClear; at: number }>();
  const prune = (m: Map<string, { at: number }>) => {
    const cutoff = now() - CLEAR_PAIR_MS;
    for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
  };
  return {
    take(userId: string): UserClear | undefined {
      prune(clears);
      const c = clears.get(userId);
      clears.delete(userId);
      return c?.clear;
    },
    wait(userId: string, rowId: string): void {
      prune(rows);
      rows.set(userId, { id: rowId, at: now() });
    },
    arrive(clear: UserClear): string | undefined {
      prune(rows);
      const row = rows.get(clear.target_user_id);
      if (row) {
        rows.delete(clear.target_user_id);
        return row.id;
      }
      prune(clears);
      clears.set(clear.target_user_id, { clear, at: now() });
      return undefined;
    },
  };
}
