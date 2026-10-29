// User cards in their own windows. Mirrors src-tauri/src/user_card.rs.
// A card window has no access to the main window's stores, so everything
// it shows comes through here or through the app-wide events.

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CardUser } from "../components/UserCard";
import type { ChatMessage } from "../stores/chatStore";
import type { Paint } from "../stores/paintStore";

const LABEL_PREFIX = "user-card-";

export function isCardWindow(label: string): boolean {
  return label.startsWith(LABEL_PREFIX);
}

export interface UserCardError {
  /**
   * not_a_card: the calling window is not an open card (it was closed, or
   * the main window called a card-only command).
   * window: the OS refused to create, move or show the window.
   */
  kind: "not_a_card" | "window";
  message: string;
}

export function isUserCardError(e: unknown): e is UserCardError {
  if (typeof e !== "object" || e === null) return false;
  const { kind, message } = e as { kind?: unknown; message?: unknown };
  return (
    (kind === "not_a_card" || kind === "window") && typeof message === "string"
  );
}

/**
 * Opens `user`'s card at the mouse. The unpinned card is reused if there is
 * one; pinned cards are left alone. `zoom` is the zoom setting, so the
 * window is sized to hold the card at that zoom on whichever display it
 * opens on.
 */
export function openUserCard(user: CardUser, zoom: number): Promise<void> {
  return invoke("user_card_open", { user, zoom });
}

/** The user this card window shows; null once the card is closed. */
export function currentCardUser(): Promise<CardUser | null> {
  return invoke("user_card_current");
}

/** Shows this card window. Call once it has rendered. */
export function cardReady(): Promise<void> {
  return invoke("user_card_ready");
}

/** Pinned cards stay open when they lose focus and are never reused. */
export function setCardPinned(pinned: boolean): Promise<void> {
  return invoke("user_card_set_pinned", { pinned });
}

/** Closes this card window. */
export function closeUserCard(): Promise<void> {
  return invoke("user_card_close");
}

/** Fires when this card is reused for another user. */
export function onCardUser(
  handler: (user: CardUser) => void,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<CardUser>("user_card_show", (e) =>
    handler(e.payload),
  );
}

/** The newest `limit` stored messages `userId` sent in a channel, oldest first. */
export function loadUserHistory(
  channelId: string,
  userId: string,
  limit: number,
): Promise<ChatMessage[]> {
  return invoke("chat_history_user", { channelId, userId, limit });
}

/** The 7TV paint the user wears, if the host has seen it. */
export function userPaint(userId: string): Promise<Paint | null> {
  return invoke("seventv_user_paint", { userId });
}
