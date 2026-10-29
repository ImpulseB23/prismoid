import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type {
  Category,
  ChannelInfo,
  ChannelInfoUpdate,
  ContentLabel,
} from "../../lib/streamManager";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(
  async () => [],
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const [info, setInfo] = createSignal<ChannelInfo | null>(null);
const [infoError, setInfoError] = createSignal<unknown>(null);
const [labels, setLabels] = createSignal<ContentLabel[]>([]);
const [results, setResults] = createSignal<Category[]>([]);
const update = vi.fn<(u: ChannelInfoUpdate) => Promise<boolean>>(
  async () => true,
);
const loadLabels = vi.fn(async () => {});
const search = vi.fn(async () => {});
vi.mock("../../stores/streamManagerStore", () => ({
  streamChannelInfo: () => info(),
  channelInfoPending: () => false,
  channelInfoError: () => infoError(),
  streamManagerLoading: () => false,
  contentLabels: () => labels(),
  contentLabelsError: () => null,
  loadContentLabels: () => loadLabels(),
  updateChannelInfo: (u: ChannelInfoUpdate) => update(u),
  categoryResults: () => results(),
  categorySearchError: () => null,
  categorySearching: () => false,
  searchCategories: () => search(),
}));

const { default: StreamSetup } = await import("./StreamSetup");

const channel: ChannelInfo = {
  broadcaster_id: "7",
  title: "ranked grind",
  game_id: "21779",
  game_name: "League of Legends",
  broadcaster_language: "en",
  tags: ["English", "Ranked"],
  content_classification_labels: ["ProfanityVulgarity", "MatureGame"],
  is_branded_content: false,
};

const labelList: ContentLabel[] = [
  { id: "ProfanityVulgarity", name: "Profanity or vulgarity", description: "" },
  { id: "Gambling", name: "Gambling", description: "Real money" },
  { id: "MatureGame", name: "Mature-rated game", description: "" },
];

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

describe("StreamSetup", () => {
  beforeEach(() => setInfo(channel));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setInfoError(null);
    setLabels([]);
    setResults([]);
  });

  it("waits for the channel and says why it failed", () => {
    setInfo(null);
    render(() => <StreamSetup />);
    expect(screen.getByText("Loading your stream")).toBeTruthy();
    expect(loadLabels).toHaveBeenCalledOnce();
    setInfoError({ kind: "http", message: "" });
    expect(screen.getByText(/Could not reach Twitch/)).toBeTruthy();
  });

  it("sends only what changed and discards back", async () => {
    render(() => <StreamSetup />);
    const title = screen.getByLabelText(/^Title/) as HTMLTextAreaElement;
    expect(title.value).toBe("ranked grind");
    expect(screen.getByText("128 left")).toBeTruthy();
    const saveButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Save changes",
    });
    expect(saveButton.disabled).toBe(true);

    fireEvent.input(title, { target: { value: "road to masters " } });
    save();
    expect(update).toHaveBeenCalledWith({ title: "road to masters" });
    expect(await screen.findByText("Saved")).toBeTruthy();

    fireEvent.input(title, { target: { value: "something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(title.value).toBe("ranked grind");
    expect(saveButton.disabled).toBe(true);
  });

  it("edits tags, language, labels and branded content", () => {
    setLabels(labelList);
    render(() => <StreamSetup />);
    expect(loadLabels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove English" }));
    const tag = screen.getByLabelText("Add a tag");
    fireEvent.input(tag, { target: { value: "Chill" } });
    fireEvent.keyDown(tag, { key: "Enter" });
    expect(screen.getByText("2 of 10")).toBeTruthy();

    const language = screen.getByLabelText("Language") as HTMLSelectElement;
    expect(language.value).toBe("en");
    fireEvent.change(language, { target: { value: "de" } });

    expect(
      screen.getByText("Profanity or vulgarity, Mature-rated game"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText(/Gambling/));
    fireEvent.click(screen.getByLabelText(/Profanity or vulgarity/));
    expect(
      (screen.getByLabelText(/Mature-rated game/) as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: /Branded content/ }));
    save();
    expect(update).toHaveBeenCalledWith({
      tags: ["Ranked", "Chill"],
      broadcaster_language: "de",
      content_classification_labels: [
        { id: "Gambling", is_enabled: true },
        { id: "ProfanityVulgarity", is_enabled: false },
      ],
      is_branded_content: true,
    });
  });

  it("changes and removes the category", async () => {
    setResults([
      {
        id: "509658",
        name: "Just Chatting",
        box_art_url: "art-{width}x{height}",
      },
    ]);
    render(() => <StreamSetup />);
    expect(screen.getByText("League of Legends")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const query = screen.getByLabelText("Search categories");
    expect(document.activeElement).toBe(query);
    fireEvent.input(query, { target: { value: "just" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Just Chatting" }),
    );
    save();
    expect(update).toHaveBeenLastCalledWith({ game_id: "509658" });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("No category")).toBeTruthy();
    save();
    expect(update).toHaveBeenLastCalledWith({ game_id: "" });
  });

  it("shows a save error", () => {
    setInfoError({ kind: "labels_not_allowed", message: "" });
    render(() => <StreamSetup />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Twitch would not set those labels",
    );
  });
});
