// Pure completion logic for the composer: find the word under the caret,
// rank emote and chatter candidates against it, and splice the choice back
// into the draft. No DOM or Solid here so it can be tested directly.

import type { EmoteMeta } from "../stores/chatStore";

export interface Chatter {
  id: string;
  login: string;
  display_name: string;
}

export interface WordAtCaret {
  start: number;
  end: number;
  word: string;
}

export type Candidate =
  | { kind: "emote"; emote: EmoteMeta; insert: string }
  | { kind: "user"; chatter: Chatter; insert: string };

export const MAX_CANDIDATES = 8;

/** Whitespace-delimited token containing the caret. */
export function wordAtCaret(text: string, caret: number): WordAtCaret {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start, end, word: text.slice(start, caret) };
}

/**
 * Candidates for `word`, best first. A leading `@` restricts to chatters,
 * a leading `:` restricts to emotes (the Twitch web client's convention);
 * a bare word of two or more characters searches both. Prefix matches rank
 * above substring matches, then shorter codes, then alphabetical.
 */
export function complete(
  word: string,
  emotes: EmoteMeta[],
  chatters: Chatter[],
): Candidate[] {
  if (word.startsWith("@")) {
    return rankUsers(word.slice(1), chatters);
  }
  if (word.startsWith(":")) {
    return rankEmotes(word.slice(1), emotes);
  }
  if (word.length < 2) return [];
  return [...rankEmotes(word, emotes), ...rankUsers(word, chatters)].slice(
    0,
    MAX_CANDIDATES,
  );
}

function rankEmotes(query: string, emotes: EmoteMeta[]): Candidate[] {
  if (query.length === 0) return [];
  const q = query.toLowerCase();
  return rank(emotes, (e) => e.code.toLowerCase(), q).map((emote) => ({
    kind: "emote",
    emote,
    insert: emote.code,
  }));
}

function rankUsers(query: string, chatters: Chatter[]): Candidate[] {
  const q = query.toLowerCase();
  const pool =
    q.length === 0
      ? chatters.slice(0, MAX_CANDIDATES)
      : rank(chatters, (c) => c.login, q);
  return pool.map((chatter) => ({
    kind: "user",
    chatter,
    insert: `@${chatter.display_name}`,
  }));
}

function rank<T>(items: T[], key: (item: T) => string, q: string): T[] {
  const prefix: T[] = [];
  const infix: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (k.startsWith(q)) prefix.push(item);
    else if (k.includes(q)) infix.push(item);
  }
  const byLength = (a: T, b: T) =>
    key(a).length - key(b).length || key(a).localeCompare(key(b));
  prefix.sort(byLength);
  infix.sort(byLength);
  return [...prefix, ...infix].slice(0, MAX_CANDIDATES);
}

export interface Applied {
  text: string;
  caret: number;
}

/** Replaces the token at `at` with `insert` plus a trailing space. */
export function applyCompletion(
  text: string,
  at: WordAtCaret,
  insert: string,
): Applied {
  const before = text.slice(0, at.start);
  const after = text.slice(at.end).replace(/^\s/, "");
  const next = `${before}${insert} ${after}`;
  return { text: next, caret: before.length + insert.length + 1 };
}
