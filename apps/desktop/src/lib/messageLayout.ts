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
// Timestamps are set in the brand mono face at a smaller size; the feed
// applies the identical font to `.msg__time` so measurement matches.
export const TIMESTAMP_FONT_FAMILY = '"JetBrains Mono", Consolas, monospace';

/** Chat text sizes in px, stepped through with Ctrl +/- and Ctrl+scroll. */
export const TEXT_SIZES = [14, 15, 16, 18, 20, 22, 24, 27, 30, 34, 40];
export const DEFAULT_TEXT_SIZE = 20;

/** Everything in a chat row that scales with the text size. */
export interface TextMetrics {
  fontSize: number;
  lineHeight: number;
  timestampSize: number;
  badgeSize: number;
  textFont: string;
  usernameFont: string;
  timestampFont: string;
  /** System notices (subs, raids) set their line a step heavier than chat. */
  noticeFont: string;
}

const metricsCache = new Map<number, TextMetrics>();

// Proportions come from the original 15px design: 22px lines, 12px
// timestamps, 18px badges.
export function textMetrics(fontSize: number): TextMetrics {
  const cached = metricsCache.get(fontSize);
  if (cached) return cached;
  const timestampSize = Math.round((fontSize * 12) / 15);
  const m: TextMetrics = {
    fontSize,
    lineHeight: Math.round((fontSize * 22) / 15),
    timestampSize,
    badgeSize: Math.round((fontSize * 18) / 15),
    textFont: `400 ${fontSize}px ${MESSAGE_FONT_FAMILY}`,
    usernameFont: `600 ${fontSize}px ${MESSAGE_FONT_FAMILY}`,
    timestampFont: `400 ${timestampSize}px ${TIMESTAMP_FONT_FAMILY}`,
    noticeFont: `500 ${fontSize}px ${MESSAGE_FONT_FAMILY}`,
  };
  metricsCache.set(fontSize, m);
  return m;
}

// The "First message" label pinned to the right of a chatter's first message.
// Its font and the gap before it are measured once, and the row keeps that
// width free so text never runs under it.
export const FIRST_LABEL_TEXT = "First message";
export const FIRST_LABEL_FONT = `600 11px ${MESSAGE_FONT_FAMILY}`;
const FIRST_LABEL_GAP = 10;

let firstLabelReserve: number | undefined;
/** Width a first-message row holds back on its right for the label. */
export function firstLabelWidth(): number {
  firstLabelReserve ??=
    measureNaturalWidth(
      prepareWithSegments(FIRST_LABEL_TEXT, FIRST_LABEL_FONT),
    ) + FIRST_LABEL_GAP;
  return firstLabelReserve;
}

// Every distinct face Pretext measures with. The renderer waits for these
// to decode before laying out so canvas metrics match the painted text;
// a face decodes once for every size, so the default size covers them all.
const defaults = textMetrics(DEFAULT_TEXT_SIZE);
export const MEASURED_FONTS = [
  defaults.textFont,
  defaults.usernameFont,
  defaults.timestampFont,
  defaults.noticeFont,
  FIRST_LABEL_FONT,
];

export const MESSAGE_LINE_HEIGHT = defaults.lineHeight;
export const MESSAGE_PADDING_Y = 4;
// Horizontal padding applied to every message row; Pretext must measure
// against the container width minus both sides or the last-word-per-line
// overflow will never wrap and measured heights will be too small.
export const MESSAGE_PADDING_X = 8;

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
  /** A line under the badge's name when hovered, e.g. "20 months". */
  detail: string | null;
}

/** The months on a subscriber badge, the only detail Twitch sends. */
export function badgeDetail(
  setId: string,
  info: string | undefined,
): string | null {
  if (setId !== "subscriber" || !info) return null;
  const months = Number(info);
  if (!Number.isInteger(months) || months < 1) return null;
  return months === 1 ? "1 month" : `${months} months`;
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
  metrics: TextMetrics;
}

export interface PrepareOptions {
  timestamps: boolean;
  metrics?: TextMetrics;
}

export function prepareMessage(
  msg: ChatMessage,
  resolveBadge: (setId: string, id: string) => ResolvedBadge | undefined,
  opts: PrepareOptions = { timestamps: true },
): PreparedMessage {
  const m = opts.metrics ?? defaults;
  const pieces = linkify(
    splitMessage(msg.message_text, msg.emote_spans, {
      maxHeight: m.lineHeight,
    }),
  );

  const badges: BadgeRender[] = [];
  for (const b of msg.badges) {
    const resolved = resolveBadge(b.set_id, b.id);
    if (resolved) {
      badges.push({
        badge: resolved,
        setId: b.set_id,
        id: b.id,
        detail: badgeDetail(b.set_id, b.info),
      });
    }
  }

  const items: RichInlineItem[] = [];
  const placeholder = placeholderWidth(m.textFont);

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
      font: m.timestampFont,
      break: "never",
    });
  }

  if (msg.notice) {
    items.push({ text: msg.notice.system_message, font: m.noticeFont });
    if (pieces.length > 0) items.push({ text: " ", font: m.textFont });
  } else {
    const badgeExtra = Math.max(0, m.badgeSize + BADGE_GAP_PX - placeholder);
    for (let i = 0; i < badges.length; i++) {
      items.push({
        text: EMOTE_PLACEHOLDER,
        font: m.textFont,
        break: "never",
        extraWidth: badgeExtra,
      });
    }
    items.push(
      { text: msg.display_name, font: m.usernameFont, break: "never" },
      { text: ": ", font: m.textFont },
    );
  }

  for (const piece of pieces) {
    if (piece.kind === "text" || piece.kind === "link") {
      items.push({ text: piece.text, font: m.textFont });
    } else {
      items.push({
        text: EMOTE_PLACEHOLDER,
        font: m.textFont,
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
    metrics: m,
  };
}

/** `reserveRight` is width kept free on every line, for the first-message label. */
export function measureMessageHeight(
  msg: PreparedMessage,
  containerWidth: number,
  reserveRight = 0,
): number {
  const { lineHeight } = msg.metrics;
  // The quoted reply line is a single nowrap, ellipsized line in the DOM.
  const extra = msg.replyParent ? lineHeight : 0;
  const contentWidth = Math.max(
    0,
    containerWidth - MESSAGE_PADDING_X * 2 - reserveRight,
  );
  if (contentWidth <= 0) return lineHeight + extra + MESSAGE_PADDING_Y;
  const { lineCount } = measureRichInlineStats(msg.prepared, contentWidth);
  return Math.max(1, lineCount) * lineHeight + extra + MESSAGE_PADDING_Y;
}
