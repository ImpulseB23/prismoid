// Builds the right-click menu for a chat row. Pure so the set of entries
// for viewers versus moderators can be tested without a DOM.

import type { ChatMessage } from "../stores/chatStore";
import { item, separator, type MenuItem } from "../stores/contextMenuStore";
import { formatSeconds } from "./slashCommands";

export interface MessageMenuActions {
  reply: () => void;
  copyMessage: () => void;
  copyLogin: () => void;
  mention: () => void;
  viewProfile: () => void;
  openOnTwitch: () => void;
  toggleIgnore: () => void;
  deleteMessage: () => void;
  timeout: (seconds: number) => void;
  ban: () => void;
  unban: () => void;
}

export interface MessageMenuContext {
  canModerate: boolean;
  ignored: boolean;
  /** The row is the signed-in user's own message. */
  own: boolean;
  /** Timeout lengths to offer, in seconds. */
  timeouts: number[];
}

export function messageMenuItems(
  msg: ChatMessage,
  ctx: MessageMenuContext,
  act: MessageMenuActions,
): MenuItem[] {
  const items: MenuItem[] = [];
  const hasText = msg.message_text.length > 0;
  const isNotice = msg.notice !== null;
  const hasUser = msg.platform_user_id.length > 0;

  if (!isNotice && msg.status === undefined)
    items.push(item("Reply", act.reply));
  if (hasText) items.push(item("Copy message", act.copyMessage));

  if (hasUser) {
    if (items.length > 0) items.push(separator);
    items.push(item("View profile", act.viewProfile));
    items.push(item("Copy name", act.copyLogin));
    items.push(item(`Mention @${msg.username}`, act.mention));
    items.push(item("Open on Twitch", act.openOnTwitch));
    if (!ctx.own) {
      items.push(item(ctx.ignored ? "Unignore" : "Ignore", act.toggleIgnore));
    }
  }

  if (ctx.canModerate && hasUser && !ctx.own) {
    items.push(separator);
    if (!isNotice && msg.status === undefined && !msg.deleted) {
      items.push(item("Delete message", act.deleteMessage));
    }
    for (const seconds of ctx.timeouts) {
      items.push(
        item(`Timeout ${formatSeconds(seconds)}`, () => act.timeout(seconds)),
      );
    }
    items.push(item("Ban", act.ban, true));
    items.push(item("Unban", act.unban));
  }
  return items;
}
