// The user card on screen. Any surface can open one: a name in the feed, or
// the header avatar. `cardOrigin` names the surface that asked.

import { createSignal } from "solid-js";
import type { CardUser } from "../components/UserCard";

const [cardUser, setCardUser] = createSignal<CardUser | null>(null);
const [cardOrigin, setCardOrigin] = createSignal<string | null>(null);

/** `origin` identifies what was clicked, e.g. a message id. */
export function openUserCard(user: CardUser, origin: string): void {
  setCardOrigin(origin);
  setCardUser(user);
}

export function closeUserCard(): void {
  setCardOrigin(null);
  setCardUser(null);
}

export { cardUser, cardOrigin };
