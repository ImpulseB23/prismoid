import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { EmoteGroup } from "../stores/emoteStore";
import type { EmoteMeta } from "../stores/chatStore";

const [groups, setGroups] = createSignal<EmoteGroup[]>([]);
const [channel, setChannel] = createSignal<{
  display_name: string;
  profile_image_url: string;
} | null>(null);

vi.mock("../lib/chatSession", () => ({
  useSession: () => () => ({
    emotes: { revision: () => 0, groups: () => groups() },
  }),
}));
vi.mock("../stores/channelStore", () => ({
  activeChannel: () => channel(),
}));

const { default: EmotePicker } = await import("./EmotePicker");

const emote = (
  code: string,
  provider: EmoteMeta["provider"],
  extra: Partial<EmoteMeta> = {},
): EmoteMeta => ({
  id: code,
  code,
  provider,
  url_1x: `${code}-1x`,
  url_2x: `${code}-2x`,
  url_4x: `${code}-4x`,
  width: 28,
  height: 28,
  animated: false,
  zero_width: false,
  ...extra,
});

const sets: EmoteGroup[] = [
  {
    label: "7TV Channel",
    scope: "channel",
    emotes: [
      emote("catJAM", "7tv", { owner: { display_name: "Uploader" } }),
      emote("Clap", "7tv"),
    ],
  },
  {
    label: "Twitch Global",
    scope: "global",
    emotes: [emote("Kappa", "twitch")],
  },
  { label: "Empty", scope: "global", emotes: [] },
];

const onPick = vi.fn<(e: EmoteMeta) => void>();
const onClose = vi.fn();

const renderPicker = (open = true) =>
  render(() => <EmotePicker open={open} onPick={onPick} onClose={onClose} />);

// jsdom has no Element.scrollTo
const scroller = () => {
  const box = document.querySelector(".emote-picker__scroll") as HTMLDivElement;
  box.scrollTo = vi.fn();
  return box;
};

describe("EmotePicker", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setGroups([]);
    setChannel(null);
  });

  it("renders nothing when closed", () => {
    renderPicker(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says emotes are still loading with no sets", () => {
    renderPicker();
    expect(
      screen.getByText("Emotes load once the channel connects."),
    ).toBeTruthy();
  });

  it("lists sets with names, counts and a total", async () => {
    setChannel({ display_name: "Forsen", profile_image_url: "avatar.png" });
    setGroups(sets);
    renderPicker();
    expect(screen.getByText("Forsen's Emotes")).toBeTruthy();
    expect(screen.getByText("Twitch Global")).toBeTruthy();
    expect(screen.getByText("Empty")).toBeTruthy();
    expect(screen.getByText("3 emotes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "catJAM" })).toBeTruthy();
    await Promise.resolve();
    expect(document.activeElement).toBe(screen.getByLabelText("Search emotes"));
  });

  it("shows the channel avatar on the channel rail button", () => {
    setChannel({ display_name: "Forsen", profile_image_url: "avatar.png" });
    setGroups(sets);
    renderPicker();
    const rail = screen.getByRole("navigation", { name: "Emote sets" });
    const btn = rail.querySelector('[aria-label="Forsen\'s Emotes"]')!;
    expect(btn.querySelector("img")?.getAttribute("src")).toBe("avatar.png");
    expect(rail.querySelectorAll("img").length).toBe(1);
  });

  it("filters across sets and hides the rail while searching", () => {
    setGroups(sets);
    renderPicker();
    const box = scroller();
    fireEvent.input(screen.getByLabelText("Search emotes"), {
      target: { value: "  KAP " },
    });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("button", { name: "Kappa" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clap" })).toBeNull();
    expect(screen.getByText("1 emotes")).toBeTruthy();
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("reports no matches for a search that finds nothing", () => {
    setGroups(sets);
    renderPicker();
    scroller();
    fireEvent.input(screen.getByLabelText("Search emotes"), {
      target: { value: "zzz " },
    });
    expect(screen.getByText('No emotes match "zzz".')).toBeTruthy();
  });

  it("previews the hovered emote with its owner or provider", () => {
    setGroups(sets);
    renderPicker();
    fireEvent.pointerEnter(screen.getByRole("button", { name: "catJAM" }));
    const preview = document.querySelector(".emote-picker__preview")!;
    expect(preview.textContent).toContain("catJAM");
    expect(preview.textContent).toContain("by Uploader");
    expect(
      preview.querySelector(".emote-picker__preview-img")?.getAttribute("src"),
    ).toBe("catJAM-4x");
    fireEvent.focus(screen.getByRole("button", { name: "Kappa" }));
    expect(preview.textContent).toContain("Kappa");
    expect(preview.textContent).toContain("Twitch");
  });

  it("hands the clicked emote to onPick", () => {
    setGroups(sets);
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Clap" }));
    expect(onPick).toHaveBeenCalledWith(sets[0]!.emotes[1]);
  });

  it("closes on escape and outside clicks only", () => {
    setGroups(sets);
    renderPicker();
    fireEvent.keyDown(screen.getByLabelText("Search emotes"), { key: "a" });
    fireEvent.mouseDown(screen.getByRole("button", { name: "Kappa" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Search emotes"), {
      key: "Escape",
    });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("jumps to a set from the rail and tracks the set on scroll", () => {
    setGroups(sets);
    renderPicker();
    const box = scroller();
    const tops = [100, 300, 500];
    document
      .querySelectorAll("section")
      .forEach((el, i) =>
        Object.defineProperty(el, "offsetTop", { value: tops[i] }),
      );
    Object.defineProperty(box, "offsetTop", { value: 100 });
    const rail = screen.getAllByRole("button", { name: /Global|7TV|Empty/ });
    const on = () =>
      rail.findIndex((b) => b.classList.contains("emote-picker__rail-btn--on"));
    expect(on()).toBe(0);

    fireEvent.click(rail[1]!);
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 200 });
    expect(on()).toBe(1);

    box.scrollTop = 450;
    fireEvent.scroll(box);
    expect(on()).toBe(2);
    box.scrollTop = 0;
    fireEvent.scroll(box);
    expect(on()).toBe(0);
  });
});
