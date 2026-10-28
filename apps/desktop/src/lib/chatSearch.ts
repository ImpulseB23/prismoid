// Search over chat that is already loaded. A query is plain words, all of
// which must appear, plus optional `from:name` and `has:link` filters, the
// same shorthand Chatterino uses.

import type { ChatMessage } from "../stores/chatStore";

export interface ChatQuery {
  words: string[];
  from: string | null;
  hasLink: boolean;
}

const LINK = /\b(?:https?:\/\/|www\.)\S/i;

export function parseQuery(input: string): ChatQuery {
  const q: ChatQuery = { words: [], from: null, hasLink: false };
  for (const token of input.trim().split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower.startsWith("from:") && lower.length > 5) {
      q.from = lower.slice(5).replace(/^@/, "");
    } else if (lower === "has:link") {
      q.hasLink = true;
    } else {
      q.words.push(lower);
    }
  }
  return q;
}

export function isEmpty(q: ChatQuery): boolean {
  return q.words.length === 0 && q.from === null && !q.hasLink;
}

export function matches(msg: ChatMessage, q: ChatQuery): boolean {
  if (
    q.from !== null &&
    msg.username.toLowerCase() !== q.from &&
    msg.display_name.toLowerCase() !== q.from
  ) {
    return false;
  }
  if (q.hasLink && !LINK.test(msg.message_text)) return false;
  const text = msg.message_text.toLowerCase();
  return q.words.every((w) => text.includes(w));
}
