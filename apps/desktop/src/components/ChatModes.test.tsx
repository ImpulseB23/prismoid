import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { ChatSettings } from "../lib/twitchChannel";

const [modes, setModes] = createSignal<ChatSettings | null>(null);
const [error, setError] = createSignal<unknown>(null);
const apply = vi.fn<(patch: unknown) => Promise<void>>(async () => {});

vi.mock("../stores/chatSettingsStore", () => ({
  chatSettings: () => modes(),
  chatSettingsBusy: () => false,
  chatSettingsError: () => error(),
  applyChatSettings: (p: unknown) => apply(p),
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

const toggle = (name: string) =>
  fireEvent.change(screen.getByRole("checkbox", { name: new RegExp(name) }), {
    target: { checked: true },
  });

describe("ChatModes", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setModes(null);
    setError(null);
  });

  it("shows loading until twitch answers", () => {
    render(() => <ChatModes />);
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("shows the load error in place of the switches", () => {
    setError(new Error("nope"));
    render(() => <ChatModes />);
    expect(screen.getByText("nope")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("turns modes on with the default durations", () => {
    setModes(off);
    render(() => <ChatModes />);
    toggle("Slow mode");
    toggle("Followers-only");
    toggle("Subscribers-only");
    toggle("Emote-only");
    toggle("Unique chat");
    toggle("Non-moderator delay");
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

  it("changes durations from the selects of active modes", () => {
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
    const [slow, followers, delay] = screen.getAllByRole("combobox");
    fireEvent.change(slow, { target: { value: "60" } });
    fireEvent.change(followers, { target: { value: "30" } });
    fireEvent.change(delay, { target: { value: "6" } });
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { slow_mode: true, slow_mode_wait_time: 60 },
      { follower_mode: true, follower_mode_duration: 30 },
      { non_moderator_chat_delay: true, non_moderator_chat_delay_duration: 6 },
    ]);
  });

  it("shows an apply error under the switches", () => {
    setModes(off);
    setError(new Error("forbidden"));
    render(() => <ChatModes />);
    expect(screen.getByRole("alert").textContent).toBe("forbidden");
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
  });
});
