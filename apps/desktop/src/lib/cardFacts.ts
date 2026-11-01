// What a user card's header shows about someone: profile, sub, followers
// and follow date. The card window fetches these before it shows a person,
// so the card opens whole; the host caches each answer, so the card's own
// lookups right after return at once.

import type { CardUser } from "../components/UserCard";
import { getFollowerCount, getFollowSince, getSubAge } from "./twitchChannel";
import {
  FOLLOWERS_SCOPE,
  currentUserId,
  missingScopes,
} from "../stores/authStore";
import { canModerateIn } from "../stores/roleStore";
import { loadUserInfo, userInfo } from "../stores/userInfoStore";

/** How long a card waits for these before showing without the rest. */
export const CARD_FACTS_WAIT_MS = 1500;

/**
 * Twitch tells you your own follow, and anyone's in a channel you moderate
 * once the followers scope is granted; elsewhere it says nothing.
 */
export function followLookup(
  user: CardUser,
): readonly [channel: string, user: string] | false {
  const own = user.platform_user_id === currentUserId();
  const mod =
    canModerateIn(user.channel_id) &&
    !missingScopes().includes(FOLLOWERS_SCOPE);
  return own || mod ? [user.channel_id, user.platform_user_id] : false;
}

/** Settles once the facts are in or the wait is over; never rejects. */
export function preloadCardFacts(
  user: CardUser,
  wait = CARD_FACTS_WAIT_MS,
): Promise<void> {
  const facts = loadUserInfo([user.platform_user_id, user.channel_id]).then(
    () => {
      const channel = userInfo(user.channel_id)?.login;
      const follow = followLookup(user);
      return Promise.allSettled([
        channel ? getSubAge(user.username, channel) : null,
        getFollowerCount(user.platform_user_id),
        follow ? getFollowSince(...follow) : null,
      ]);
    },
  );
  return Promise.race([
    facts.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, wait)),
  ]);
}
