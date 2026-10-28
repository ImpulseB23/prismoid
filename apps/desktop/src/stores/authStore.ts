// Signed-in Twitch account as reported by the host. Shared so the shell,
// settings and moderation surfaces agree on who is logged in and whether
// the stored grant is missing scopes the app now asks for.

import { createSignal } from "solid-js";
import type { AuthStatus, ScopeGroup } from "../lib/twitchAuth";

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

const STREAM_MANAGER_SCOPES = [
  "channel:manage:broadcast",
  "channel:manage:polls",
  "channel:manage:predictions",
];

/** True when the grant predates the stream manager on the user's channel. */
export function streamManagerNeedsReconnect(): boolean {
  const missing = missingScopes();
  return STREAM_MANAGER_SCOPES.some((s) => missing.includes(s));
}

// Mirrors ScopeGroup::scopes in src-tauri/src/twitch_auth/scope_groups.rs.
const SCOPE_GROUPS: Record<ScopeGroup, string[]> = {
  ads: ["channel:read:ads", "channel:manage:ads", "channel:edit:commercial"],
  live_actions: [
    "moderator:manage:shoutouts",
    "moderator:manage:announcements",
    "moderator:manage:shield_mode",
    "clips:edit",
  ],
};

export function scopeGroupEnabled(group: ScopeGroup): boolean {
  const a = authStatus();
  return a?.state === "logged_in" && a.enabled_scope_groups.includes(group);
}

/** True when the group is on but the grant predates it. */
export function scopeGroupNeedsReconnect(group: ScopeGroup): boolean {
  if (!scopeGroupEnabled(group)) return false;
  const missing = missingScopes();
  return SCOPE_GROUPS[group].some((s) => missing.includes(s));
}
