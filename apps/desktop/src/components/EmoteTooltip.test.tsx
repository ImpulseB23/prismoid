import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { EmoteMeta } from "../stores/chatStore";
import type { EmoteHover } from "../stores/emoteCardStore";
import type { Pane } from "../lib/pane";

const [hovered, setHovered] = createSignal<EmoteHover | null>(null);
const endHover = vi.fn();

vi.mock("../stores/emoteCardStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/emoteCardStore")>()),
  hoveredEmote: () => hovered(),
  endEmoteHover: () => endHover(),
}));
// The pane the emote was hovered in, for its channel's set names.
const pane = {
  session: () => ({
    channel: { display_name: "Forsen" },
    emotes: { revision: () => 0, scopeOf: () => "channel" },
  }),
} as unknown as Pane;

const { default: EmoteTooltip } = await import("./EmoteTooltip");

const meta = (code: string, extra: Partial<EmoteMeta> = {}): EmoteMeta => ({
  id: code,
  code,
  provider: "7tv",
  url_1x: `${code}-1x`,
  url_2x: "",
  url_4x: `${code}-4x`,
  width: 28,
  height: 28,
  animated: false,
  zero_width: false,
  ...extra,
});

const at = (left: number, top: number) =>
  ({ left, top, width: 28, height: 28, bottom: top + 28 }) as DOMRect;

const tip = () => screen.getByRole("tooltip");

describe("EmoteTooltip", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 80,
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    setHovered(null);
    vi.restoreAllMocks();
    endHover.mockClear();
  });

  it("renders nothing without a hover", () => {
    render(() => <EmoteTooltip />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the emote, its overlays, set and creator", () => {
    setHovered({
      emote: meta("catJAM", { owner: { display_name: "Ayyybubu" } }),
      overlays: [meta("RainTime", { provider: "bttv" })],
      anchor: at(500, 300),
      pane,
    });
    render(() => <EmoteTooltip />);
    expect(screen.getByText("catJAM + RainTime")).toBeTruthy();
    expect(screen.getByText("Forsen's Emotes")).toBeTruthy();
    expect(screen.getByText("by Ayyybubu")).toBeTruthy();
    const srcs = [...tip().querySelectorAll(".emote-tip__art img")].map((i) =>
      i.getAttribute("src"),
    );
    expect(srcs).toEqual(["catJAM-4x", "RainTime-4x"]);
    expect(tip().querySelector(".provider-icon--7tv")).not.toBeNull();
  });

  it("sits centered above the emote", () => {
    setHovered({ emote: meta("a"), overlays: [], anchor: at(500, 300), pane });
    render(() => <EmoteTooltip />);
    expect(tip().style.top).toBe("212px");
    expect(tip().style.left).toBe("464px");
    expect(tip().style.visibility).toBe("visible");
  });

  it("flips below near the top and stays inside the window", () => {
    setHovered({
      emote: meta("a"),
      overlays: [],
      anchor: at(window.innerWidth - 10, 50),
      pane,
    });
    render(() => <EmoteTooltip />);
    expect(tip().style.top).toBe("86px");
    expect(tip().style.left).toBe(`${window.innerWidth - 108}px`);
  });

  it("hides on the user's scroll, blur and resize while shown", () => {
    render(() => <EmoteTooltip />);
    window.dispatchEvent(new Event("resize"));
    expect(endHover).not.toHaveBeenCalled();
    setHovered({ emote: meta("a"), overlays: [], anchor: at(500, 300), pane });
    document.body.dispatchEvent(new Event("scroll"));
    expect(endHover).not.toHaveBeenCalled();
    document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("resize"));
    expect(endHover).toHaveBeenCalledTimes(3);
    setHovered(null);
    window.dispatchEvent(new Event("resize"));
    expect(endHover).toHaveBeenCalledTimes(3);
  });
});
