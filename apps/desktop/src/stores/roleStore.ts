// Where the signed-in user may moderate. Seeded from Helix (channels the
// user holds the moderator role in) and confirmed live when one of their
// own messages arrives wearing the moderator badge, which also covers a
// mod role granted mid-session. The fetcher is injected for tests.

import { createSignal } from "solid-js";
import {
  getModeratedChannels,
  type ModeratedChannel,
} from "../lib/twitchChannel";
import { activeChannel } from "./channelStore";
import {
  FOLLOWERS_SCOPE,
  WARN_SCOPE,
  currentUserId,
  missingScopes,
  moderationNeedsReconnect,
} from "./authStore";

export interface RoleStore {
  /** Replaces the moderated set from Helix. Resolves false when the lookup failed. */
  load: () => Promise<boolean>;
  isModeratorOf: (channelId: string) => boolean;
  moderatesAny: () => boolean;
  noteModerator: (channelId: string) => void;
  clear: () => void;
}

export function createRoleStore(
  fetch: () => Promise<ModeratedChannel[]> = getModeratedChannels,
): RoleStore {
  const [moderated, setModerated] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  let generation = 0;

  async function load(): Promise<boolean> {
    const gen = ++generation;
    try {
      const channels = await fetch();
      if (gen !== generation) return true;
      setModerated(new Set(channels.map((c) => c.broadcaster_id)));
      return true;
    } catch (err) {
      if (gen === generation) console.error("moderated channels", err);
      return false;
    }
  }

  function noteModerator(channelId: string): void {
    if (moderated().has(channelId)) return;
    setModerated(new Set<string>([...moderated(), channelId]));
  }

  return {
    load,
    isModeratorOf: (channelId) => moderated().has(channelId),
    moderatesAny: () => moderated().size > 0,
    noteModerator,
    clear: () => {
      generation++;
      setModerated(new Set<string>());
    },
  };
}

const defaultStore = createRoleStore();
export const loadModeratedChannels = defaultStore.load;
export const noteModerator = defaultStore.noteModerator;
export const clearRoles = defaultStore.clear;

// Scopes only moderators get anything out of.
const MOD_ONLY_SCOPES = [WARN_SCOPE, FOLLOWERS_SCOPE];

/**
 * Missing scopes worth a reconnect prompt. Moderator-only scopes are only
 * asked of people who moderate someone else's chat; a streamer moderating
 * just their own is asked where the feature is first used.
 */
export function reconnectScopes(): string[] {
  const missing = missingScopes();
  return defaultStore.moderatesAny()
    ? missing
    : missing.filter((s) => !MOD_ONLY_SCOPES.includes(s));
}

/**
 * Whether moderation controls should show in a channel: the user is its
 * broadcaster or holds the moderator role there, and the token carries the
 * scopes those calls need.
 */
export function canModerateIn(channelId: string): boolean {
  const userId = currentUserId();
  if (!userId || moderationNeedsReconnect()) return false;
  return channelId === userId || defaultStore.isModeratorOf(channelId);
}

/** {@link canModerateIn} for the channel on screen. */
export function canModerate(): boolean {
  const channel = activeChannel();
  return channel ? canModerateIn(channel.id) : false;
}
