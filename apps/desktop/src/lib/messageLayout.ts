// Pretext-powered measurement for chat messages. ADR 2: Pretext is the
// source of truth for text metrics so the virtual scroller gets exact
// pixel heights without DOM reflow.

import {
  measureRichInlineStats,
  prepareRichInline,
  type PreparedRichInline,
  type RichInlineItem,
} from "@chenglou/pretext/rich-inline";
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import type { ChatMessage } from "../stores/chatStore";
import type { ResolvedBadge } from "../stores/badgeStore";
import { splitMessage, type MessagePiece } from "./emoteSpans";
import { linkify } from "./links";
import { formatTimestamp } from "./messageStyle";

// Named families only. `system-ui` is unsafe for pretext accuracy on macOS.
// Exported so `ChatFeed.tsx` applies the exact same stack that Pretext
// measures against — any drift here produces wrong heights.
export const MESSAGE_FONT_FAMILY =
  '"Outfit", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const MESSAGE_FONT_SIZE_PX = 15;
// Timestamps are set in the brand mono face at a smaller size; the DOM
// applies the identical font via `.msg__time` so measurement matches.
export const TIMESTAMP_FONT_FAMILY = '"JetBrains Mono", Consolas, monospace';
export const TIMESTAMP_FONT_SIZE_PX = 12;

const USERNAME_FONT = `600 ${MESSAGE_FONT_SIZE_PX}px ${MESSAGE_FONT_FAMILY}`;
const SEPARATOR_FONT = `400 ${MESSAGE_FONT_SIZE_PX}px ${MESSAGE_FONT_FAMILY}`;
const TEXT_FONT = `400 ${MESSAGE_FONT_SIZE_PX}px ${MESSAGE_FONT_FAMILY}`;
const TIMESTAMP_FONT = `400 ${TIMESTAMP_FONT_SIZE_PX}px ${TIMESTAMP_FONT_FAMILY}`;
// System notices (subs, raids) set their line a step heavier than chat.
const NOTICE_FONT = `500 ${MESSAGE_FONT_SIZE_PX}px ${MESSAGE_FONT_FAMILY}`;

// Every distinct font Pretext measures with. The renderer waits for these
// to decode before laying out so canvas metrics match the painted text.
export const MEASURED_FONTS = [
  TEXT_FONT,
  USERNAME_FONT,
  TIMESTAMP_FONT,
  NOTICE_FONT,
];

export const MESSAGE_LINE_HEIGHT = 22;
export const MESSAGE_PADDING_Y = 4;
// Horizontal padding applied to every message row; Pretext must measure
// against the container width minus both sides or the last-word-per-line
// overflow will never wrap and measured heights will be too small.
export const MESSAGE_PADDING_X = 8;

// Rendered badge size. Kept square and identical across providers so that
// mixed-platform chat visually aligns vertically.
export const BADGE_SIZE_PX = 18;
// Horizontal gap after each badge, before the next badge or the username.
export const BADGE_GAP_PX = 4;

// NBSP is not collapsed by Pretext's boundary-whitespace rules, so it
// survives as a measurable placeholder. Each emote becomes an atomic
// (`break: "never"`) item whose total width equals the NBSP natural
// width plus `extraWidth`, sized to match the rendered <img>.
const EMOTE_PLACEHOLDER = "\u00A0";

const placeholderWidthCache = new Map<string, number>();
function placeholderWidth(font: string): number {
  const cached = placeholderWidthCache.get(font);
  if (cached !== undefined) return cached;
  const w = measureNaturalWidth(prepareWithSegments(EMOTE_PLACEHOLDER, font));
  placeholderWidthCache.set(font, w);
  return w;
}

export interface BadgeRender {
  badge: ResolvedBadge;
  setId: string;
  id: string;
}

export interface PreparedMessage {
  prepared: PreparedRichInline;
  pieces: MessagePiece[];
  badges: BadgeRender[];
  timestamp: string;
  /** Set when the message answers another; rendered as one extra line. */
  replyParent: ChatMessage["reply_parent"];
  /** Set on system notices; the row shows this line instead of a username. */
  notice: ChatMessage["notice"];
}

export interface PrepareOptions {
  timestamps: boolean;
}

export function prepareMessage(
  msg: ChatMessage,
  resolveBadge: (setId: string, id: string) => ResolvedBadge | undefined,
  opts: PrepareOptions = { timestamps: true },
): PreparedMessage {
  const pieces = linkify(
    splitMessage(msg.message_text, msg.emote_spans, {
      maxHeight: MESSAGE_LINE_HEIGHT,
    }),
  );

  const badges: BadgeRender[] = [];
  for (const b of msg.badges) {
    const resolved = resolveBadge(b.set_id, b.id);
    if (resolved) badges.push({ badge: resolved, setId: b.set_id, id: b.id });
  }

  const items: RichInlineItem[] = [];
  const placeholder = placeholderWidth(TEXT_FONT);

  // Timestamp prefix: a single non-breaking text run so the username
  // never wraps onto a line by itself when the timestamp pushes the
  // first badge down. The trailing space keeps separation from badges
  // without needing a separate item, and we expose the exact same
  // string to the DOM so Pretext's measurement matches what renders.
  const formatted = opts.timestamps ? formatTimestamp(msg.timestamp) : "";
  const timestamp = formatted ? `${formatted} ` : "";
  if (timestamp) {
    items.push({
      text: timestamp,
      font: TIMESTAMP_FONT,
      break: "never",
    });
  }

  if (msg.notice) {
    items.push({ text: msg.notice.system_message, font: NOTICE_FONT });
    if (pieces.length > 0) items.push({ text: " ", font: TEXT_FONT });
  } else {
    const badgeExtra = Math.max(0, BADGE_SIZE_PX + BADGE_GAP_PX - placeholder);
    for (let i = 0; i < badges.length; i++) {
      items.push({
        text: EMOTE_PLACEHOLDER,
        font: TEXT_FONT,
        break: "never",
        extraWidth: badgeExtra,
      });
    }
    items.push(
      { text: msg.display_name, font: USERNAME_FONT, break: "never" },
      { text: ": ", font: SEPARATOR_FONT },
    );
  }

  for (const piece of pieces) {
    if (piece.kind === "text" || piece.kind === "link") {
      items.push({ text: piece.text, font: TEXT_FONT });
    } else {
      items.push({
        text: EMOTE_PLACEHOLDER,
        font: TEXT_FONT,
        break: "never",
        extraWidth: Math.max(0, piece.primary.width - placeholder),
      });
    }
  }

  return {
    prepared: prepareRichInline(items),
    pieces,
    badges,
    timestamp,
    replyParent: msg.reply_parent,
    notice: msg.notice,
  };
}

export function measureMessageHeight(
  msg: PreparedMessage,
  containerWidth: number,
): number {
  // The quoted reply line is a single nowrap, ellipsized line in the DOM.
  const extra = msg.replyParent ? MESSAGE_LINE_HEIGHT : 0;
  const contentWidth = Math.max(0, containerWidth - MESSAGE_PADDING_X * 2);
  if (contentWidth <= 0) return MESSAGE_LINE_HEIGHT + extra + MESSAGE_PADDING_Y;
  const { lineCount } = measureRichInlineStats(msg.prepared, contentWidth);
  return (
    Math.max(1, lineCount) * MESSAGE_LINE_HEIGHT + extra + MESSAGE_PADDING_Y
  );
}
