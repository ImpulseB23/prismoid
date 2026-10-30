import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { ChatSettings } from "../lib/twitchChannel";

const [modes, setModes] = createSignal<ChatSettings | null>(null);
const [error, setError] = createSignal<unknown>(null);
const apply = vi.fn<(patch: unknown) => Promise<void>>(async () => {});

vi.mock("../lib/chatSession", () => ({
  useSession: () => () => ({
    roomModes: {
      settings: () => modes(),
      busy: () => false,
      error: () => error(),
      apply: (p: unknown) => apply(p),
    },
  }),
}));

const { default: ChatModes } = await import("./ChatModes");
const { settings } = await import("../stores/settingsStore");

const off: ChatSettings = {
  emote_mode: false,
  follower_mode: false,
  follower_mode_duration: null,
  slow_mode: false,
  slow_mode_wait_time: null,
  subscriber_mode: false,
  unique_chat_mode: false,
  non_moderator_chat_delay: false,
  non_moderator_chat_delay_duration: null,
};

const tile = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("ChatModes", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setModes(null);
    setError(null);
  });

  it("shows loading until twitch answers", () => {
    render(() => <ChatModes />);
    expect(screen.getByText("Loading room modes")).toBeTruthy();
  });

  it("shows the load error in place of the tiles", () => {
    setError(new Error("nope"));
    render(() => <ChatModes />);
    expect(screen.getByText("nope")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("turns modes on with the default durations", () => {
    setModes(off);
    render(() => <ChatModes />);
    for (const name of [
      "Slow",
      "Followers",
      "Subs only",
      "Emotes only",
      "Unique",
      "Delay",
    ]) {
      expect(tile(name).getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(tile(name));
    }
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { slow_mode: true, slow_mode_wait_time: settings().defaultSlowSeconds },
      {
        follower_mode: true,
        follower_mode_duration: settings().defaultFollowerMinutes,
      },
      { subscriber_mode: true },
      { emote_mode: true },
      { unique_chat_mode: true },
      { non_moderator_chat_delay: true, non_moderator_chat_delay_duration: 2 },
    ]);
  });

  it("shows what each active mode does and turns it off", () => {
    setModes({
      ...off,
      slow_mode: true,
      slow_mode_wait_time: 30,
      follower_mode: true,
      follower_mode_duration: 0,
      subscriber_mode: true,
      unique_chat_mode: true,
      non_moderator_chat_delay: true,
      non_moderator_chat_delay_duration: 4,
    });
    render(() => <ChatModes />);
    expect(tile("Slow").textContent).toBe("Slow30 sec");
    expect(tile("Followers").textContent).toBe("FollowersAny follower");
    expect(tile("Subs only").textContent).toBe("Subs onlyOn");
    expect(tile("Emotes only").textContent).toBe("Emotes onlyOff");
    expect(tile("Unique").textContent).toBe("UniqueNo repeats");
    expect(tile("Delay").textContent).toBe("Delay4 sec");
    fireEvent.click(tile("Slow"));
    expect(apply).toHaveBeenCalledWith({ slow_mode: false });
  });

  it("changes durations from the pickers of active modes", () => {
    setModes({
      ...off,
      slow_mode: true,
      slow_mode_wait_time: 30,
      follower_mode: true,
      follower_mode_duration: 10,
      non_moderator_chat_delay: true,
      non_moderator_chat_delay_duration: 4,
    });
    render(() => <ChatModes />);
    fireEvent.change(screen.getByLabelText("One message every"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("Followed for"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Delay for non-mods"), {
      target: { value: "6" },
    });
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { slow_mode: true, slow_mode_wait_time: 60 },
      { follower_mode: true, follower_mode_duration: 30 },
      { non_moderator_chat_delay: true, non_moderator_chat_delay_duration: 6 },
    ]);
  });

  it("hides the pickers while no timed mode is on", () => {
    setModes({ ...off, emote_mode: true });
    render(() => <ChatModes />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows an apply error under the tiles", () => {
    setModes(off);
    setError(new Error("forbidden"));
    render(() => <ChatModes />);
    expect(screen.getByRole("alert").textContent).toBe("forbidden");
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });
});
