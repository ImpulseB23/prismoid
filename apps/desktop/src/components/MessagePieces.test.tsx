import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { PaneProvider, type Pane } from "../lib/pane";
import { createSignal } from "solid-js";
import type { EmoteMeta } from "../stores/chatStore";
import type { MessagePiece } from "../lib/emoteSpans";

const [loading, setLoading] = createSignal<string | null>(null);
const hoverEmote = vi.fn();
const endEmoteHover = vi.fn();
const inspectEmote = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../stores/emoteCardStore", () => ({
  inspectLoading: () => loading(),
  hoverEmote: (...args: unknown[]) => hoverEmote(...args),
  endEmoteHover: () => endEmoteHover(),
  inspectEmote: (...args: unknown[]) => inspectEmote(...args),
}));

const { default: MessagePieces } = await import("./MessagePieces");

const meta = (id: string, code: string): EmoteMeta => ({
  id,
  code,
  provider: "7tv",
  url_1x: `${code}.webp`,
  url_2x: "",
  url_4x: "",
  width: 28,
  height: 28,
  animated: false,
  zero_width: false,
});

const cat = meta("e1", "catJAM");
const rain = meta("e2", "RainTime");
const pieces: MessagePiece[] = [
  {
    kind: "emote",
    primary: { emote: cat, width: 28, height: 28 },
    overlays: [{ emote: rain, width: 28, height: 28 }],
  },
];

const emote = () =>
  screen.getByRole("button", { name: "catJAM + RainTime emote" });

describe("MessagePieces", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setLoading(null);
  });

  it("hovers the emote with its overlays and the pane it is in", () => {
    const pane = {} as Pane;
    render(() => (
      <PaneProvider value={pane}>
        <MessagePieces pieces={pieces} />
      </PaneProvider>
    ));
    fireEvent.pointerEnter(emote());
    expect(hoverEmote).toHaveBeenCalledWith(emote(), cat, [rain], pane);
    fireEvent.pointerLeave(emote());
    expect(endEmoteHover).toHaveBeenCalled();
  });

  it("marks the emote busy while its card loads", () => {
    render(() => <MessagePieces pieces={pieces} />);
    expect(emote().getAttribute("aria-busy")).toBe("false");
    setLoading("e1");
    expect(emote().getAttribute("aria-busy")).toBe("true");
    expect(emote().classList.contains("msg__emote--loading")).toBe(true);
    setLoading("e2");
    expect(emote().classList.contains("msg__emote--loading")).toBe(false);
  });

  it("opens the card on click", () => {
    render(() => <MessagePieces pieces={pieces} />);
    fireEvent.click(emote());
    // Outside any pane, as in a user card window.
    expect(inspectEmote).toHaveBeenCalledWith(cat, undefined);
  });
});
