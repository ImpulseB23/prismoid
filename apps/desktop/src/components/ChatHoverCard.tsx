// Hover cards for badges and names in chat. A badge shows large with its
// name; a name shows the chatter's picture, login and how old the account
// is, with clicking the name still opening their full card.

import { Component, Show } from "solid-js";
import {
  badgeLarge,
  chatHover,
  endChatHover,
  type ChatHover,
} from "../stores/chatHoverStore";
import {
  formatJoined,
  isNewAccount,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";
import HoverTip from "./HoverTip";

type UserHover = Extract<ChatHover, { kind: "user" }>;

const UserTip: Component<{ hover: UserHover }> = (props) => {
  const info = () => {
    userInfoRevision();
    return userInfo(props.hover.userId);
  };
  const showLogin = () =>
    props.hover.login.toLowerCase() !== props.hover.displayName.toLowerCase();
  return (
    <>
      <Show
        when={info()?.profile_image_url}
        fallback={
          <span class="user-tip__picture user-tip__picture--initial">
            {props.hover.displayName.slice(0, 1)}
          </span>
        }
      >
        {(src) => (
          <img
            class="user-tip__picture"
            src={src()}
            alt=""
            width={40}
            height={40}
            draggable={false}
          />
        )}
      </Show>
      <span class="user-tip__who">
        <span
          class="user-tip__name"
          classList={{ "name--painted": props.hover.painted }}
          style={props.hover.nameStyle}
        >
          {props.hover.displayName}
        </span>
        <Show when={showLogin()}>
          <span class="user-tip__login">{props.hover.login}</span>
        </Show>
        <Show when={info()}>
          {(i) => (
            <span
              class="user-tip__joined"
              classList={{
                "user-tip__joined--new": isNewAccount(i(), Date.now()),
              }}
            >
              {formatJoined(i().created_at, Date.now())}
            </span>
          )}
        </Show>
      </span>
    </>
  );
};

const ChatHoverCard: Component = () => {
  const badge = () => {
    const h = chatHover();
    return h?.kind === "badge" ? h : null;
  };
  const user = () => {
    const h = chatHover();
    return h?.kind === "user" ? h : null;
  };
  return (
    <>
      <Show when={badge()}>
        {(b) => (
          <HoverTip
            anchor={b().anchor}
            class="emote-tip"
            onDismiss={endChatHover}
          >
            <div class="emote-tip__art">
              <img src={badgeLarge(b().badge)} alt="" draggable={false} />
            </div>
            <span class="emote-tip__code">{b().badge.title}</span>
          </HoverTip>
        )}
      </Show>
      <Show when={user()}>
        {(u) => (
          <HoverTip
            anchor={u().anchor}
            class="emote-tip user-tip"
            onDismiss={endChatHover}
          >
            <UserTip hover={u()} />
          </HoverTip>
        )}
      </Show>
    </>
  );
};

export default ChatHoverCard;
