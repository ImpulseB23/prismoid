import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../stores/chatStore";
import type { ResolvedBadge } from "../stores/badgeStore";

// Pretext measures on a canvas jsdom does not have. The stubs keep the
// items it is handed so the tests can check what the layout asked for.
vi.mock("@chenglou/pretext/rich-inline", () => ({
  prepareRichInline: (items: unknown[]) => ({ items }),
  measureRichInlineStats: () => ({ lineCount: 2 }),
}));
vi.mock("@chenglou/pretext", () => ({
  prepareWithSegments: () => ({}),
  measureNaturalWidth: () => 4,
}));

const {
  DEFAULT_TEXT_SIZE,
  MESSAGE_PADDING_Y,
  TEXT_SIZES,
  measureMessageHeight,
  prepareMessage,
  textMetrics,
} = await import("./messageLayout");

interface Item {
  text: string;
  font: string;
  extraWidth?: number;
}
const itemsOf = (p: { prepared: unknown }) =>
  (p.prepared as { items: Item[] }).items;

const msg = (over: Partial<ChatMessage> = {}) =>
  ({
    timestamp: 0,
    display_name: "Viewer",
    message_text: "hello there",
    emote_spans: [],
    badges: [{ set_id: "mod", id: "1" }],
    reply_parent: null,
    notice: null,
    ...over,
  }) as unknown as ChatMessage;

const badge = () => ({ title: "Moderator" }) as unknown as ResolvedBadge;

describe("textMetrics", () => {
  it("keeps the original proportions at the default size", () => {
    const m = textMetrics(DEFAULT_TEXT_SIZE);
    expect(m.lineHeight).toBe(22);
    expect(m.timestampSize).toBe(12);
    expect(m.badgeSize).toBe(18);
    expect(m.textFont).toContain("400 15px");
  });

  it("scales every size up together and caches per size", () => {
    const big = textMetrics(TEXT_SIZES.at(-1)!);
    expect(big.lineHeight).toBeGreaterThan(big.fontSize);
    expect(big.badgeSize).toBeGreaterThan(18);
    expect(textMetrics(TEXT_SIZES.at(-1)!)).toBe(big);
  });
});

describe("prepareMessage", () => {
  it("lays the row out in the chosen text size", () => {
    const m = textMetrics(20);
    const p = prepareMessage(msg(), badge, { timestamps: true, metrics: m });
    const items = itemsOf(p);
    expect(items[0]!.font).toBe(m.timestampFont);
    expect(items[1]!.extraWidth).toBe(m.badgeSize + 4 - 4);
    expect(items.find((i) => i.text === "Viewer")!.font).toBe(m.usernameFont);
    expect(items.at(-1)!.font).toBe(m.textFont);
    expect(p.metrics).toBe(m);
    expect(measureMessageHeight(p, 300)).toBe(
      2 * m.lineHeight + MESSAGE_PADDING_Y,
    );
  });

  it("uses the default size and adds a line for a reply", () => {
    const p = prepareMessage(
      msg({
        reply_parent: { user_login: "a" } as ChatMessage["reply_parent"],
      }),
      () => undefined,
    );
    const m = textMetrics(DEFAULT_TEXT_SIZE);
    expect(p.metrics).toBe(m);
    expect(measureMessageHeight(p, 300)).toBe(
      3 * m.lineHeight + MESSAGE_PADDING_Y,
    );
    expect(measureMessageHeight(p, 0)).toBe(
      2 * m.lineHeight + MESSAGE_PADDING_Y,
    );
  });

  it("sets notices in the heavier notice face", () => {
    const m = textMetrics(18);
    const p = prepareMessage(
      msg({
        notice: { system_message: "Viewer subscribed" },
      } as Partial<ChatMessage>),
      badge,
      { timestamps: false, metrics: m },
    );
    const items = itemsOf(p);
    expect(items[0]).toMatchObject({
      text: "Viewer subscribed",
      font: m.noticeFont,
    });
    expect(items[1]).toMatchObject({ text: " ", font: m.textFont });
  });
});
