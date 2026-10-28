// The user card on screen. Any surface can open one: a name in the feed, or
// the header avatar. The profile and avatar load before the card shows so it
// never fills in afterwards; `cardLoading` names the surface that asked, for
// its loading cue.

import { createSignal } from "solid-js";
import type { CardUser } from "../components/UserCard";
import { preloadImages } from "../lib/preload";
import { loadUserInfo, userInfo } from "./userInfoStore";

const [cardUser, setCardUser] = createSignal<CardUser | null>(null);
const [cardLoading, setCardLoading] = createSignal<string | null>(null);
const [cardOrigin, setCardOrigin] = createSignal<string | null>(null);
let seq = 0;

/** `origin` identifies what was clicked, e.g. a message id. */
export function openUserCard(user: CardUser, origin: string): void {
  const s = ++seq;
  const id = user.platform_user_id;
  setCardLoading(origin);
  void loadUserInfo([id])
    .then(() => preloadImages([userInfo(id)?.profile_image_url ?? ""]))
    .then(() => {
      if (s !== seq) return;
      setCardLoading(null);
      setCardOrigin(origin);
      setCardUser(user);
    });
}

export function closeUserCard(): void {
  ++seq;
  setCardLoading(null);
  setCardOrigin(null);
  setCardUser(null);
}

export { cardUser, cardLoading, cardOrigin };
