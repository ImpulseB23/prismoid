// Signed-in Twitch account as reported by the host. Shared so the shell,
// settings and moderation surfaces agree on who is logged in and whether
// the stored grant is missing scopes the app now asks for.

import { createSignal } from "solid-js";
import type { AuthStatus } from "../lib/twitchAuth";

const [authStatus, setAuthStatus] = createSignal<AuthStatus | null>(null);

export { authStatus, setAuthStatus };

export function currentUserId(): string | null {
  const a = authStatus();
  return a?.state === "logged_in" ? a.user_id : null;
}

/** Scopes the app requests that the stored token was granted without. */
export function missingScopes(): string[] {
  const a = authStatus();
  return a?.state === "logged_in" ? a.missing_scopes : [];
}

const MODERATION_SCOPES = [
  "user:read:moderated_channels",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
];

/** True when moderation calls would fail until the user signs in again. */
export function moderationNeedsReconnect(): boolean {
  const missing = missingScopes();
  return MODERATION_SCOPES.some((s) => missing.includes(s));
}

/**
 * True when the grant predates the AutoMod queue. Kept apart from
 * moderationNeedsReconnect so an older grant keeps the rest of the mod
 * tools while the queue asks for a reconnect.
 */
export function automodNeedsReconnect(): boolean {
  return missingScopes().includes("moderator:manage:automod");
}
