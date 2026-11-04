// @mentions in chat text, found the way Twitch logins are spelled (letters,
// digits and underscores, up to 25), so "me@example.com" stays plain text.
// Also builds a message's pieces for every view that renders one.

import {
  splitMessage,
  type MessagePiece,
  type SizeEmoteOptions,
} from "./emoteSpans";
import type { EmoteSpan } from "../stores/chatStore";
import type { ChatterStore } from "../stores/chatterStore";
import type { Chatter } from "./completion";
import { linkify } from "./links";
import type { Channel } from "./twitchChannel";

const MENTION_RE = /(^|[^\w@])@(\w{1,25})(?!\w)/g;

export function mentionify(pieces: MessagePiece[]): MessagePiece[] {
  const out: MessagePiece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "text") {
      out.push(piece);
      continue;
    }
    let cursor = 0;
    for (const m of piece.text.matchAll(MENTION_RE)) {
      const start = m.index + m[1]!.length;
      if (start > cursor) {
        out.push({ kind: "text", text: piece.text.slice(cursor, start) });
      }
      const text = `@${m[2]!}`;
      out.push({ kind: "mention", text, login: m[2]!.toLowerCase() });
      cursor = start + text.length;
    }
    if (cursor === 0) out.push(piece);
    else if (cursor < piece.text.length) {
      out.push({ kind: "text", text: piece.text.slice(cursor) });
    }
  }
  return out;
}

/** Text, links, mentions and emotes of one message. */
export function chatPieces(
  text: string,
  spans: EmoteSpan[],
  opts: SizeEmoteOptions,
): MessagePiece[] {
  return mentionify(linkify(splitMessage(text, spans, opts)));
}

/**
 * Who an @mention names: someone who spoke here, the channel's owner, or
 * anyone else by a login lookup.
 */
export function mentionedUser(
  login: string,
  chatters: ChatterStore,
  channel: Channel,
  lookup: (login: string) => Promise<Channel>,
): Promise<Chatter> {
  const known = chatters.byLogin(login);
  if (known) return Promise.resolve(known);
  const asChatter = (c: Channel): Chatter => ({
    id: c.id,
    login: c.login,
    display_name: c.display_name,
    color: null,
  });
  if (channel.login === login) return Promise.resolve(asChatter(channel));
  return lookup(login).then(asChatter);
}
