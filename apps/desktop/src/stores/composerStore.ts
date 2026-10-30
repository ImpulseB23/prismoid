// Lets other surfaces (the feed, the thread, the emote card) hand state to
// a pane's composer without a direct component reference. Insert requests
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

export interface Composer {
  insertRequest: () => InsertRequest | null;
  replyTarget: () => ReplyTarget | null;
  /** Appends `text` to the draft as its own word. */
  requestInsert: (text: string) => void;
  requestMention: (login: string) => void;
  requestReply: (target: ReplyTarget) => void;
  clearReply: () => void;
}

export function createComposer(): Composer {
  const [insertRequest, setInsertRequest] = createSignal<InsertRequest | null>(
    null,
  );
  const [replyTarget, setReplyTarget] = createSignal<ReplyTarget | null>(null);
  let seq = 0;
  const requestInsert = (text: string) =>
    setInsertRequest({ seq: ++seq, text });
  return {
    insertRequest,
    replyTarget,
    requestInsert,
    requestMention: (login) => requestInsert(`@${login}`),
    requestReply: setReplyTarget,
    clearReply: () => setReplyTarget(null),
  };
}
