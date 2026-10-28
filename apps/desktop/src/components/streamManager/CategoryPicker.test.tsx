import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Category } from "../../lib/streamManager";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const [results, setResults] = createSignal<Category[]>([]);
const [searchError, setSearchError] = createSignal<unknown>(null);
const [searching, setSearching] = createSignal(false);
const search = vi.fn<(q: string) => Promise<void>>(async () => {});
vi.mock("../../stores/streamManagerStore", () => ({
  categoryResults: () => results(),
  categorySearchError: () => searchError(),
  categorySearching: () => searching(),
  searchCategories: (q: string) => search(q),
}));

const { default: CategoryPicker } = await import("./CategoryPicker");

const league = { id: "21779", name: "League of Legends" };

describe("CategoryPicker", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setResults([]);
    setSearchError(null);
    setSearching(false);
  });

  it("finds box art for the current category by id", async () => {
    invoke.mockResolvedValueOnce([
      { id: "1", name: "League of Legends: Wild Rift", box_art_url: "x" },
      { ...league, box_art_url: "lol-{width}x{height}.jpg" },
    ]);
    const { container } = render(() => (
      <CategoryPicker value={league} onPick={() => {}} />
    ));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "lol-78x104.jpg",
      ),
    );
    expect(invoke).toHaveBeenCalledWith("twitch_search_categories", {
      query: "League of Legends",
    });
  });

  it("keeps a plain tile when the art lookup fails", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(() => (
      <CategoryPicker value={league} onPick={() => {}} />
    ));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
    error.mockRestore();
  });

  it("searches after a pause and closes on Escape", async () => {
    vi.useFakeTimers();
    try {
      const [value, setValue] = createSignal({ id: "", name: "" });
      render(() => <CategoryPicker value={value()} onPick={setValue} />);
      expect(screen.getByText("No category")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Change" }));
      const query = screen.getByLabelText("Search categories");
      fireEvent.input(query, { target: { value: "zzz" } });
      expect(search).not.toHaveBeenCalledWith("zzz");
      vi.advanceTimersByTime(250);
      expect(search).toHaveBeenCalledWith("zzz");
      expect(screen.getByText("No matches")).toBeTruthy();
      setSearching(true);
      expect(screen.getByText("Searching")).toBeTruthy();
      setSearchError({ kind: "http", message: "" });
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not reach Twitch",
      );
      fireEvent.keyDown(query, { key: "Escape" });
      expect(screen.queryByLabelText("Search categories")).toBeNull();
      expect(search).toHaveBeenLastCalledWith("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a search", () => {
    render(() => <CategoryPicker value={league} onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Search categories")).toBeNull();
  });
});
