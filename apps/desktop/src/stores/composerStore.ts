// Lets other surfaces (the feed, the user card, the emote card) hand state
// to the composer without a direct component reference. Insert requests
// carry a sequence number so the same text can be inserted twice in a
// row; the reply target is plain state the composer shows and clears.

import { createSignal } from "solid-js";

export interface InsertRequest {
  seq: number;
  text: string;
}

export interface ReplyTarget {
  message_id: string;
  user_login: string;
  user_name: string;
  body: string;
}

const [insertRequest, setInsertRequest] = createSignal<InsertRequest | null>(
  null,
);
const [replyTarget, setReplyTarget] = createSignal<ReplyTarget | null>(null);
let seq = 0;

export { insertRequest, replyTarget };

/** Appends `text` to the draft as its own word. */
export function requestInsert(text: string): void {
  setInsertRequest({ seq: ++seq, text });
}

export function requestMention(login: string): void {
  requestInsert(`@${login}`);
}

export function requestReply(target: ReplyTarget): void {
  setReplyTarget(target);
}

export function clearReply(): void {
  setReplyTarget(null);
}
