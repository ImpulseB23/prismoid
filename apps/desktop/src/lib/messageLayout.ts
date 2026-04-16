// Pretext-powered measurement for chat messages. ADR 2: Pretext is the
// source of truth for text metrics so the virtual scroller gets exact
// pixel heights without DOM reflow.

import {
  measureRichInlineStats,
  prepareRichInline,
  type PreparedRichInline,
} from "@chenglou/pretext/rich-inline";
import type { ChatMessage } from "../stores/chatStore";

// Named families only. `system-ui` is unsafe for pretext accuracy on macOS.
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const USERNAME_FONT = `700 13px ${FONT_FAMILY}`;
const SEPARATOR_FONT = `400 13px ${FONT_FAMILY}`;
const TEXT_FONT = `400 13px ${FONT_FAMILY}`;

export const MESSAGE_LINE_HEIGHT = 20;
export const MESSAGE_PADDING_Y = 4;

export function prepareMessage(msg: ChatMessage): PreparedRichInline {
  return prepareRichInline([
    {
      text: msg.display_name,
      font: USERNAME_FONT,
      break: "never",
    },
    { text: ": ", font: SEPARATOR_FONT },
    { text: msg.message_text, font: TEXT_FONT },
  ]);
}

export function measureMessageHeight(
  prepared: PreparedRichInline,
  width: number,
): number {
  if (width <= 0) return MESSAGE_LINE_HEIGHT + MESSAGE_PADDING_Y;
  const { lineCount } = measureRichInlineStats(prepared, width);
  return Math.max(1, lineCount) * MESSAGE_LINE_HEIGHT + MESSAGE_PADDING_Y;
}
