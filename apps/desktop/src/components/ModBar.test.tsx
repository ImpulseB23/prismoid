import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { ChatSettings } from "../lib/twitchChannel";

const [canMod, setCanMod] = createSignal(true);
const [channel, setChannel] = createSignal({ id: "100" });
const [modes, setModes] = createSignal<ChatSettings | null>(null);
const apply = vi.fn<(patch: unknown) => Promise<void>>(async () => {});
const load = vi.fn<(id: string) => Promise<void>>(async () => {});
const openPanel = vi.fn();

vi.mock("../stores/roleStore", () => ({ canModerate: () => canMod() }));
vi.mock("../stores/channelStore", () => ({ activeChannel: () => channel() }));
vi.mock("../stores/authStore", () => ({ currentUserId: () => "100" }));
vi.mock("../stores/chatSettingsStore", () => ({
  chatSettings: () => modes(),
  chatSettingsBusy: () => false,
  applyChatSettings: (p: unknown) => apply(p),
  loadChatSettings: (id: string) => load(id),
}));
vi.mock("../stores/modesPanelStore", () => ({
  setModesOpen: (v: boolean) => openPanel(v),
}));

const { default: ModBar } = await import("./ModBar");

const settings: ChatSettings = {
  emote_mode: false,
  follower_mode: false,
  follower_mode_duration: null,
  slow_mode: true,
  slow_mode_wait_time: 30,
  subscriber_mode: false,
  unique_chat_mode: false,
  non_moderator_chat_delay: false,
  non_moderator_chat_delay_duration: null,
};

describe("ModBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the room modes and flips one with a tap", () => {
    setModes(settings);
    render(() => <ModBar />);
    expect(load).toHaveBeenCalledWith("100");
    expect(screen.getByText("Your channel")).toBeTruthy();
    const slow = screen.getByRole("button", { name: "Slow 30s" });
    expect(slow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slow);
    expect(apply).toHaveBeenCalledWith({ slow_mode: false });
    fireEvent.click(screen.getByRole("button", { name: "Emotes" }));
    expect(apply).toHaveBeenCalledWith({ emote_mode: true });
    fireEvent.click(screen.getByRole("button", { name: "Modes" }));
    expect(openPanel).toHaveBeenCalledWith(true);
  });

  it("labels a moderator and stays hidden without the role", () => {
    setChannel({ id: "200" });
    render(() => <ModBar />);
    expect(screen.getByText("Moderator")).toBeTruthy();
    setCanMod(false);
    expect(screen.queryByRole("toolbar")).toBeNull();
    setCanMod(true);
    setChannel({ id: "100" });
  });
});
