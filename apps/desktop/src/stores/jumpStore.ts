// A request to scroll chat to one message, from Mentions, search or a user
// card. The feed switches to the message's channel if needed, scrolls it
// into view and clears the request.

import { createSignal } from "solid-js";

export interface JumpRequest {
  channel_id: string;
  message_id: string;
}

const [jumpRequest, setJumpRequest] = createSignal<JumpRequest | null>(null);

export { jumpRequest };

export function jumpToMessage(channelId: string, messageId: string): void {
  setJumpRequest({ channel_id: channelId, message_id: messageId });
}

export function clearJump(): void {
  setJumpRequest(null);
}
