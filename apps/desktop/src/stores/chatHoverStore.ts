// The small card shown while the pointer rests on a badge or a chatter's
// name in chat. Emotes have their own tooltip (emoteCardStore); this one
// waits the same moment before showing, so sweeping across chat is quiet.

import { createSignal, type JSX } from "solid-js";
import type { ResolvedBadge } from "./badgeStore";
import { HOVER_DELAY_MS } from "./emoteCardStore";
import { ensureUserInfo } from "./userInfoStore";
import { preloadImages } from "../lib/preload";

export type ChatHover =
  | { kind: "badge"; badge: ResolvedBadge; anchor: DOMRect }
  | {
      kind: "user";
      userId: string;
      login: string;
      displayName: string;
      /** The name's color or 7TV paint, as it shows in chat. */
      nameStyle: JSX.CSSProperties;
      painted: boolean;
      anchor: DOMRect;
    };

const [chatHover, setChatHover] = createSignal<ChatHover | null>(null);
let seq = 0;

export { chatHover };

export const badgeLarge = (b: ResolvedBadge) =>
  b.url_4x || b.url_2x || b.url_1x;

function show(
  el: HTMLElement,
  ready: Promise<unknown>,
  make: (anchor: DOMRect) => ChatHover,
): void {
  const mine = ++seq;
  void Promise.all([
    new Promise((r) => setTimeout(r, HOVER_DELAY_MS)),
    ready,
  ]).then(() => {
    if (mine !== seq || !el.isConnected) return;
    setChatHover(make(el.getBoundingClientRect()));
  });
}

export function hoverBadge(el: HTMLElement, badge: ResolvedBadge): void {
  show(el, preloadImages([badgeLarge(badge)], 400), (anchor) => ({
    kind: "badge",
    badge,
    anchor,
  }));
}

export function hoverUser(
  el: HTMLElement,
  user: Omit<Extract<ChatHover, { kind: "user" }>, "kind" | "anchor">,
): void {
  // The picture and account age fill in when the profile arrives.
  ensureUserInfo([user.userId]);
  show(el, Promise.resolve(), (anchor) => ({ kind: "user", ...user, anchor }));
}

export function endChatHover(): void {
  ++seq;
  setChatHover(null);
}
