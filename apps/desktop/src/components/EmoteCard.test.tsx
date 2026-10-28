import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { EmoteMeta } from "../stores/chatStore";
import type { EmoteScope } from "../stores/emoteStore";
import type { SevenTvUser } from "../lib/sevenTvUsers";

const [emote, setEmote] = createSignal<EmoteMeta | null>(null);
const [addedBy, setAddedBy] = createSignal<SevenTvUser | null>(null);
const [scope, setScope] = createSignal<EmoteScope | undefined>(undefined);
const close = vi.fn(() => setEmote(null));
const requestInsert = vi.fn();
const openUrl = vi.fn<(url: string) => Promise<void>>(async () => {});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));
vi.mock("../stores/emoteCardStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/emoteCardStore")>()),
  inspectedEmote: () => emote(),
  inspectedAddedBy: () => addedBy(),
  closeEmoteCard: () => close(),
}));
vi.mock("../stores/emoteStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/emoteStore")>()),
  emoteScope: () => scope(),
}));
vi.mock("../stores/channelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/channelStore")>()),
  activeChannel: () => ({ display_name: "Forsen" }),
}));
vi.mock("../stores/composerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/composerStore")>()),
  requestInsert: (text: string) => requestInsert(text),
}));

const { default: EmoteCard } = await import("./EmoteCard");

const meta = (extra: Partial<EmoteMeta> = {}): EmoteMeta => ({
  id: "e1",
  code: "catJAM",
  provider: "7tv",
  url_1x: "1x.webp",
  url_2x: "2x.webp",
  url_4x: "4x.webp",
  width: 28,
  height: 28,
  animated: true,
  zero_width: false,
  ...extra,
});

describe("EmoteCard", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setEmote(null);
    setAddedBy(null);
    setScope(undefined);
  });

  it("renders nothing while closed", () => {
    render(() => <EmoteCard />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the emote large with its creator and set", () => {
    setScope("channel");
    setEmote(meta({ owner: { display_name: "Ayyybubu" } }));
    render(() => <EmoteCard />);
    const dialog = screen.getByRole("dialog", { name: "catJAM emote" });
    expect(
      screen.getByRole("img", { name: "catJAM" }).getAttribute("src"),
    ).toBe("4x.webp");
    expect(screen.getByText("by Ayyybubu")).toBeTruthy();
    expect(screen.getByText("Forsen's Emotes")).toBeTruthy();
    expect(screen.getByText("Animated")).toBeTruthy();
    expect(dialog.querySelector(".provider-icon--7tv")).not.toBeNull();
  });

  it("describes a static overlay from a global set", () => {
    setScope("global");
    setEmote(meta({ provider: "bttv", animated: false, zero_width: true }));
    render(() => <EmoteCard />);
    expect(screen.getByText("BTTV Global")).toBeTruthy();
    expect(screen.getByText("Static, overlay")).toBeTruthy();
    expect(screen.queryByText("Added")).toBeNull();
  });

  it("shows who added it and when", () => {
    setAddedBy({ id: "u1", login: "xqc", display_name: "xQc" });
    setEmote(meta({ added_at: Date.UTC(2021, 4, 26, 12) }));
    render(() => <EmoteCard />);
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getByText(/^by xQc · .*2021$/)).toBeTruthy();
  });

  it("shows just the date when the adder is unknown", () => {
    setEmote(meta({ added_at: Date.UTC(2021, 4, 26, 12) }));
    render(() => <EmoteCard />);
    expect(screen.getByText(/2021$/).textContent).not.toContain("by");
  });

  it("inserts the code into chat and closes", () => {
    setEmote(meta());
    render(() => <EmoteCard />);
    fireEvent.click(screen.getByRole("button", { name: "Use in chat" }));
    expect(requestInsert).toHaveBeenCalledWith("catJAM");
    expect(close).toHaveBeenCalled();
  });

  it("copies the name", async () => {
    setEmote(meta());
    render(() => <EmoteCard />);
    fireEvent.click(screen.getByRole("button", { name: "Copy name" }));
    expect(writeText).toHaveBeenCalledWith("catJAM");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("opens the provider page", () => {
    setEmote(meta({ provider: "ffz", id: "9" }));
    render(() => <EmoteCard />);
    fireEvent.click(screen.getByRole("button", { name: "FrankerFaceZ" }));
    expect(openUrl).toHaveBeenCalledWith(
      "https://www.frankerfacez.com/emoticon/9",
    );
  });

  it("has no provider link for twitch emotes", () => {
    setEmote(meta({ provider: "twitch" }));
    render(() => <EmoteCard />);
    expect(screen.queryByRole("button", { name: "Twitch" })).toBeNull();
    expect(screen.getByText("Twitch")).toBeTruthy();
  });

  it("closes from the button, escape and the backdrop", () => {
    setEmote(meta());
    render(() => <EmoteCard />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    setEmote(meta());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    setEmote(meta());
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(close).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(close).toHaveBeenCalledTimes(3);
  });
});
