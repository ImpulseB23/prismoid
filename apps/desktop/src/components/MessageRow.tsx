// One chat message in a list outside the feed (search, mentions, threads,
// the user card): who said it and when on top, the message underneath.
// Renders as a list item for an `ol.msg-list`. A clickable row gets a
// button stretched over it, so trailing buttons can sit on top of it
// without nesting one button in another.

import { Component, JSX, Show } from "solid-js";
import type { ChatMessage } from "../stores/chatStore";
import { isLight } from "../stores/themeStore";
import { formatTimestamp, normalizeUserColor } from "../lib/messageStyle";
import { splitMessage } from "../lib/emoteSpans";
import { MESSAGE_LINE_HEIGHT } from "../lib/messageLayout";
import MessagePieces from "./MessagePieces";

export interface MessageRowProps {
  msg: ChatMessage;
  /** Left of the name, e.g. the channel's avatar. */
  lead?: JSX.Element;
  /** After the name, e.g. the channel it was said in. */
  detail?: JSX.Element;
  /** Hides the name, for lists that are all one chatter. */
  hideName?: boolean;
  /** Shown at the end on hover, e.g. a delete button. */
  trailing?: JSX.Element;
  mention?: boolean;
  /** Not yet seen: a thin prism line under the message. */
  unread?: boolean;
  /** Indented under the message above, for replies in a thread. */
  reply?: boolean;
  /** One tight line, time then text, for a single chatter's history. */
  compact?: boolean;
  onClick?: () => void;
}

const MessageRow: Component<MessageRowProps> = (props) => (
  <li
    class="msg-list__item"
    classList={{ "msg-list__item--reply": props.reply === true }}
  >
    <div
      class="msg-row"
      classList={{
        "msg-row--action": props.onClick !== undefined,
        "msg-row--mention": props.mention === true,
        "msg-row--unread": props.unread === true,
        "msg-row--compact": props.compact === true,
        "msg-row--deleted": props.msg.deleted === true,
      }}
    >
      <Show when={props.onClick}>
        {(click) => (
          <button
            type="button"
            class="msg-row__hit"
            aria-label={`Jump to ${props.msg.display_name}'s message`}
            onClick={() => click()()}
          />
        )}
      </Show>
      <Show when={props.lead}>
        <span class="msg-row__lead">{props.lead}</span>
      </Show>
      <span class="msg-row__main">
        <span class="msg-row__meta">
          <Show when={!props.hideName}>
            <span
              class="msg-row__name"
              style={{ color: normalizeUserColor(props.msg.color, isLight()) }}
            >
              {props.msg.display_name}
            </span>
          </Show>
          <Show when={props.detail}>
            <span class="msg-row__detail">{props.detail}</span>
          </Show>
          <span class="msg-row__time">
            {formatTimestamp(props.msg.timestamp)}
          </span>
        </span>
        <span class="msg-row__text">
          <MessagePieces
            pieces={splitMessage(
              props.msg.message_text,
              props.msg.emote_spans,
              {
                maxHeight: MESSAGE_LINE_HEIGHT,
              },
            )}
          />
        </span>
      </span>
      <Show when={props.trailing}>
        <span class="msg-row__trailing">{props.trailing}</span>
      </Show>
    </div>
  </li>
);

export default MessageRow;
