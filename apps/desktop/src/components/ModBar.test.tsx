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
vi.mock("../stores/authStore", () => ({
  currentUserId: () => "100",
  automodNeedsReconnect: () => false,
}));
vi.mock("../stores/chatSettingsStore", () => ({
  chatSettings: () => modes(),
  chatSettingsBusy: () => false,
  applyChatSettings: (p: unknown) => apply(p),
  loadChatSettings: (id: string) => load(id),
}));
vi.mock("../stores/modesPanelStore", () => ({
  setModesOpen: (v: boolean) => openPanel(v),
}));
const clear = vi.fn<(id: string) => Promise<void>>(async () => {});
vi.mock("../lib/twitchAuth", () => ({
  clearChat: (id: string) => clear(id),
}));

const { default: ModBar, CLEAR_CONFIRM_MS } = await import("./ModBar");
const { clearHeldMessages, recordHeldMessage } =
  await import("../stores/automodStore");

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

  it("clears chat only on a second tap", async () => {
    vi.useFakeTimers();
    try {
      render(() => <ModBar />);
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(clear).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CLEAR_CONFIRM_MS);
      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      fireEvent.click(screen.getByRole("button", { name: "Clear chat?" }));
      expect(clear).toHaveBeenCalledWith("100");
      await vi.runAllTimersAsync();
      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows why a clear failed", async () => {
    clear.mockRejectedValueOnce({
      kind: "helix",
      code: "403",
      message: "not a moderator",
    });
    render(() => <ModBar />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear chat?" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not a moderator",
    );

    clear.mockRejectedValueOnce("sidecar went away");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear chat?" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("sidecar went away"),
    );
  });

  it("counts held messages for the open channel and opens the queue", () => {
    render(() => <ModBar />);
    const button = () => screen.getByRole("button", { name: /^AutoMod/ });
    expect(button().textContent).toBe("AutoMod");
    for (const [id, channel] of [
      ["a", "100"],
      ["b", "100"],
      ["c", "200"],
    ]) {
      recordHeldMessage({
        kind: "automod_held",
        channel_id: channel,
        message_id: id,
        user_id: "42",
        user_login: "chatter",
        user_name: "Chatter",
        text: "held",
        reason: "automod",
        category: "swearing",
        level: 1,
        held_at: 0,
      });
    }
    expect(button().textContent).toBe("AutoMod2");
    fireEvent.click(button());
    expect(screen.getByRole("dialog", { name: "AutoMod queue" })).toBeTruthy();
    clearHeldMessages();
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
