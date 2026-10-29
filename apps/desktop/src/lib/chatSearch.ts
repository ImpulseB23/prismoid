// Search over chat that is already loaded. A query is plain words, all of
// which must appear, plus `key:value` filters in the style of Discord's
// search: from:, mentions:, has: and is:. Filters of the same key narrow
// together, so `is:mod is:sub` means both.

import type { ChatMessage } from "../stores/chatStore";

export const HAS_VALUES = ["link", "emote"] as const;
export const IS_VALUES = [
  "first",
  "reply",
  "mod",
  "vip",
  "sub",
  "streamer",
] as const;

export type HasValue = (typeof HAS_VALUES)[number];
export type IsValue = (typeof IS_VALUES)[number];

export interface ChatQuery {
  words: string[];
  from: string | null;
  mentions: string | null;
  has: HasValue[];
  is: IsValue[];
}

/** One recognised filter in the input, for the chips under the field. */
export interface FilterToken {
  key: FilterKey;
  value: string;
  /** The token as typed, so a chip can remove exactly it. */
  raw: string;
}

export type FilterKey = "from" | "mentions" | "has" | "is";

export const FILTER_KEYS: { key: FilterKey; hint: string }[] = [
  { key: "from", hint: "Messages someone sent" },
  { key: "mentions", hint: "Messages that @ someone" },
  { key: "has", hint: "A link or an emote" },
  { key: "is", hint: "First message, reply, mod, VIP, sub or streamer" },
];

const VALUE_HINTS: Record<HasValue | IsValue, string> = {
  link: "Has a link",
  emote: "Has an emote",
  first: "Their first message in the channel",
  reply: "A reply to someone",
  mod: "Sent by a moderator",
  vip: "Sent by a VIP",
  sub: "Sent by a subscriber",
  streamer: "Sent by the streamer",
};

const LINK = /\b(?:https?:\/\/|www\.)\S/i;

const BADGES_FOR: Record<"mod" | "vip" | "sub" | "streamer", string[]> = {
  mod: ["moderator"],
  vip: ["vip"],
  sub: ["subscriber", "founder"],
  streamer: ["broadcaster"],
};

function readToken(token: string): FilterToken | null {
  const at = token.indexOf(":");
  if (at <= 0) return null;
  const key = token.slice(0, at).toLowerCase();
  const value = token
    .slice(at + 1)
    .toLowerCase()
    .replace(/^@/, "");
  if (!value) return null;
  if (key === "from" || key === "mentions") return { key, value, raw: token };
  if (key === "has" && (HAS_VALUES as readonly string[]).includes(value)) {
    return { key, value, raw: token };
  }
  if (key === "is" && (IS_VALUES as readonly string[]).includes(value)) {
    return { key, value, raw: token };
  }
  return null;
}

export function filterTokens(input: string): FilterToken[] {
  return input
    .trim()
    .split(/\s+/)
    .flatMap((t) => {
      const f = t ? readToken(t) : null;
      return f ? [f] : [];
    });
}

export function parseQuery(input: string): ChatQuery {
  const q: ChatQuery = {
    words: [],
    from: null,
    mentions: null,
    has: [],
    is: [],
  };
  for (const token of input.trim().split(/\s+/)) {
    if (!token) continue;
    const f = readToken(token);
    if (!f) {
      q.words.push(token.toLowerCase());
    } else if (f.key === "from") {
      q.from = f.value;
    } else if (f.key === "mentions") {
      q.mentions = f.value;
    } else if (f.key === "has") {
      q.has.push(f.value as HasValue);
    } else {
      q.is.push(f.value as IsValue);
    }
  }
  return q;
}

export function isEmpty(q: ChatQuery): boolean {
  return (
    q.words.length === 0 &&
    q.from === null &&
    q.mentions === null &&
    q.has.length === 0 &&
    q.is.length === 0
  );
}

/** What `matches` needs to know beyond the message itself. */
export interface MatchContext {
  isFirst: (messageId: string) => boolean;
  isEmote: (word: string) => boolean;
}

function mentionsName(msg: ChatMessage, name: string): boolean {
  if (msg.reply_parent?.user_login.toLowerCase() === name) return true;
  return msg.message_text
    .toLowerCase()
    .split(/\s+/)
    .some((w) => w.replace(/^@/, "").replace(/[,.!?:;]+$/, "") === name);
}

export function matches(
  msg: ChatMessage,
  q: ChatQuery,
  ctx: MatchContext,
): boolean {
  if (
    q.from !== null &&
    msg.username.toLowerCase() !== q.from &&
    msg.display_name.toLowerCase() !== q.from
  ) {
    return false;
  }
  if (q.mentions !== null && !mentionsName(msg, q.mentions)) return false;
  for (const h of q.has) {
    if (h === "link" && !LINK.test(msg.message_text)) return false;
    if (
      h === "emote" &&
      msg.emote_spans.length === 0 &&
      !msg.message_text.split(/\s+/).some((w) => ctx.isEmote(w))
    ) {
      return false;
    }
  }
  for (const i of q.is) {
    if (i === "first") {
      if (!msg.first_message && !ctx.isFirst(msg.id)) return false;
    } else if (i === "reply") {
      if (msg.reply_parent === null) return false;
    } else if (!msg.badges.some((b) => BADGES_FOR[i].includes(b.set_id))) {
      return false;
    }
  }
  const text = msg.message_text.toLowerCase();
  return q.words.every((w) => text.includes(w));
}

export interface Suggestion {
  /** What the last word of the input becomes when this is picked. */
  insert: string;
  label: string;
  hint: string;
}

/** A name to offer for from: and mentions:. */
export interface NameOption {
  login: string;
  display_name: string;
}

const MAX_NAMES = 8;

/**
 * Options for the word being typed, the last one in the input: the filter
 * keys on an empty box or while a key is being typed, then the values that
 * fit the key once it has its colon.
 */
export function suggest(input: string, names: NameOption[]): Suggestion[] {
  const last = /(\S*)$/.exec(input)?.[1] ?? "";
  const at = last.indexOf(":");
  if (at < 0) {
    const typed = last.toLowerCase();
    // Between words of a query the keys would only push the results down.
    if (!typed && input.trim()) return [];
    return FILTER_KEYS.filter((k) => k.key.startsWith(typed)).map((k) => ({
      insert: `${k.key}:`,
      label: `${k.key}:`,
      hint: k.hint,
    }));
  }
  const key = last.slice(0, at).toLowerCase();
  const typed = last
    .slice(at + 1)
    .toLowerCase()
    .replace(/^@/, "");
  if (key === "from" || key === "mentions") {
    return names
      .filter(
        (n) =>
          n.login.startsWith(typed) ||
          n.display_name.toLowerCase().startsWith(typed),
      )
      .slice(0, MAX_NAMES)
      .map((n) => ({
        insert: `${key}:${n.login} `,
        label: n.display_name,
        hint: n.login === n.display_name.toLowerCase() ? "" : n.login,
      }));
  }
  const values: readonly string[] =
    key === "has" ? HAS_VALUES : key === "is" ? IS_VALUES : [];
  return values
    .filter((v) => v.startsWith(typed))
    .map((v) => ({
      insert: `${key}:${v} `,
      label: `${key}:${v}`,
      hint: VALUE_HINTS[v as HasValue | IsValue],
    }));
}

/** The input with its last word swapped for a picked suggestion. */
export function applySuggestion(input: string, s: Suggestion): string {
  return input.replace(/\S*$/, s.insert);
}

/** The input without one filter, for a chip's remove button. */
export function removeToken(input: string, raw: string): string {
  const parts = input.trim().split(/\s+/);
  const i = parts.indexOf(raw);
  if (i >= 0) parts.splice(i, 1);
  return parts.join(" ");
}
