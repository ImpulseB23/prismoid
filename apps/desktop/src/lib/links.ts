// Splits text pieces into text and link pieces. Only explicit http(s) and
// www. links are detected; bare domains are left as text so ordinary chat
// like "lol.ok" never turns into a link. Trailing punctuation that chat
// usually puts after a link is kept out of the href.

import type { MessagePiece } from "./emoteSpans";

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_RE = /[.,;:!?)\]}'"]+$/;

export function findLinks(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(TRAILING_RE, "");
    out.push({ start: m.index, end: m.index + raw.length });
  }
  return out;
}

export function hrefFor(linkText: string): string {
  return /^https?:\/\//i.test(linkText) ? linkText : `https://${linkText}`;
}

export function linkify(pieces: MessagePiece[]): MessagePiece[] {
  const out: MessagePiece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "text") {
      out.push(piece);
      continue;
    }
    const links = findLinks(piece.text);
    if (links.length === 0) {
      out.push(piece);
      continue;
    }
    let cursor = 0;
    for (const { start, end } of links) {
      if (start > cursor) {
        out.push({ kind: "text", text: piece.text.slice(cursor, start) });
      }
      const text = piece.text.slice(start, end);
      out.push({ kind: "link", text, href: hrefFor(text) });
      cursor = end;
    }
    if (cursor < piece.text.length) {
      out.push({ kind: "text", text: piece.text.slice(cursor) });
    }
  }
  return out;
}
