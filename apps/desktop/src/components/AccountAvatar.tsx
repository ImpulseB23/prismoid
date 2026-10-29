// The signed-in user in the header: their Twitch picture with their top
// badge for the open channel on its corner (Streamer, Lead Mod, Mod, VIP...).
// Clicking it opens the account panel.

import { Component, Show, createMemo } from "solid-js";
import type { ChatMessage } from "../stores/chatStore";
import { sessionFor } from "../lib/chatSession";
import { activeChannel } from "../stores/channelStore";
import { currentUserId } from "../stores/authStore";
import { ownBadges } from "../stores/ownIdentityStore";
import { holdsModRole } from "../stores/roleStore";
import { accountOpen, setAccountOpen } from "../stores/accountPanelStore";
import AccountPanel from "./AccountPanel";
import type { Attention } from "../lib/settingsAttention";
import {
  ensureUserInfo,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";

const AccountAvatar: Component<{
  login: string;
  /** Shown as a dot on the avatar; the panel leads to it. */
  attention: Attention | null;
  onSignOut: () => void;
}> = (props) => {
  // The newest message the user sent here carries their exact badges and
  // color. When none is loaded, the badges remembered from their last
  // message in the channel stand in, then their role. With no channel open
  // the avatar stays, without badges, so the account is always in reach.
  const self = createMemo(() => {
    const me = currentUserId();
    if (!me) return null;
    const channel = activeChannel();
    if (!channel) {
      return {
        channel_id: null,
        platform_user_id: me,
        username: props.login,
        display_name: props.login,
        color: null,
        badges: [],
      };
    }
    const chat = sessionFor(channel.id)?.chat;
    chat?.messageRevision();
    const last: ChatMessage | undefined = chat
      ?.recentByUser(me, 1)
      .find((m) => m.channel_id === channel.id);
    const roleBadges =
      channel.id === me
        ? [{ set_id: "broadcaster", id: "1" }]
        : holdsModRole(channel.id)
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
    const badges = sessionFor(activeChannel()?.id)?.badges;
    badges?.revision();
    for (const b of self()?.badges ?? []) {
      const r = badges?.resolve(b.set_id, b.id);
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
        <>
          <button
            type="button"
            class="avatar"
            aria-haspopup="dialog"
            aria-expanded={accountOpen()}
            title={
              props.attention
                ? `Chatting as ${s().display_name}. Settings: ${props.attention.text}`
                : `Chatting as ${s().display_name}`
            }
            aria-label={
              props.attention
                ? `Your account, chatting as ${s().display_name}. Settings needs you`
                : `Your account, chatting as ${s().display_name}`
            }
            onClick={() => setAccountOpen(true)}
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
            <Show when={props.attention}>
              <span class="avatar__dot" aria-hidden="true" />
            </Show>
          </button>
          <AccountPanel
            open={accountOpen()}
            login={s().username}
            displayName={s().display_name}
            picture={picture()}
            badges={s().badges}
            attention={props.attention}
            onClose={() => setAccountOpen(false)}
            onSignOut={props.onSignOut}
          />
        </>
      )}
    </Show>
  );
};

export default AccountAvatar;
