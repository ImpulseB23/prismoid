// The signed-in user in the header: their Twitch picture with their top
// badge for the open channel on its corner (Streamer, Lead Mod, Mod, VIP...).
// Clicking it opens their own user card for the channel.

import { Component, Show, createMemo } from "solid-js";
import type { ChatMessage } from "../stores/chatStore";
import { messageRevision, recentMessagesByUser } from "../stores/chatStore";
import { activeChannel } from "../stores/channelStore";
import { currentUserId } from "../stores/authStore";
import { ownBadges } from "../stores/ownBadgeStore";
import { canModerate } from "../stores/roleStore";
import { badgeRevision, resolveBadge } from "../stores/badgeStore";
import { cardLoading, openUserCard } from "../stores/userCardStore";
import {
  ensureUserInfo,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";

const AccountAvatar: Component<{ login: string }> = (props) => {
  // The newest message the user sent here carries their exact badges and
  // color. When none is loaded, the badges remembered from their last
  // message in the channel stand in, then their role.
  const self = createMemo(() => {
    messageRevision();
    const me = currentUserId();
    const channel = activeChannel();
    if (!me || !channel) return null;
    const last: ChatMessage | undefined = recentMessagesByUser(me, 1).find(
      (m) => m.channel_id === channel.id,
    );
    const roleBadges =
      channel.id === me
        ? [{ set_id: "broadcaster", id: "1" }]
        : canModerate()
          ? [{ set_id: "moderator", id: "1" }]
          : [];
    return {
      channel_id: channel.id,
      platform_user_id: me,
      username: last?.username ?? props.login,
      display_name: last?.display_name ?? props.login,
      color: last?.color ?? null,
      badges: last?.badges ?? ownBadges(channel.id) ?? roleBadges,
    };
  });

  // Twitch lists the most important badge first.
  const topBadge = () => {
    badgeRevision();
    for (const b of self()?.badges ?? []) {
      const r = resolveBadge(b.set_id, b.id);
      if (r) return r;
    }
    return undefined;
  };

  const picture = () => {
    userInfoRevision();
    const me = currentUserId();
    if (!me) return undefined;
    ensureUserInfo([me]);
    return userInfo(me)?.profile_image_url || undefined;
  };

  return (
    <Show when={self()}>
      {(s) => (
        <button
          type="button"
          class="avatar"
          classList={{ "avatar--loading": cardLoading() === "self" }}
          aria-busy={cardLoading() === "self"}
          title={`Chatting as ${s().display_name}`}
          aria-label={`Your card, chatting as ${s().display_name}`}
          onClick={() => openUserCard(s(), "self")}
        >
          <Show
            when={picture()}
            fallback={
              <span class="avatar__initial" aria-hidden="true">
                {s().display_name.slice(0, 1)}
              </span>
            }
          >
            {(src) => (
              <img class="avatar__img" src={src()} alt="" draggable={false} />
            )}
          </Show>
          <Show when={topBadge()}>
            {(b) => (
              <img
                class="avatar__badge"
                src={b().url_1x}
                srcset={`${b().url_1x} 1x, ${b().url_2x} 2x, ${b().url_4x} 4x`}
                alt={b().title}
                title={b().title}
                draggable={false}
              />
            )}
          </Show>
        </button>
      )}
    </Show>
  );
};

export default AccountAvatar;
