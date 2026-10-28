import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { ChatSettings } from "../lib/twitchChannel";

const [canMod, setCanMod] = createSignal(true);
const [channel, setChannel] = createSignal({ id: "100" });
const [modes, setModes] = createSignal<ChatSettings | null>(null);
const apply = vi.fn<(patch: unknown) => Promise<void>>(async () => {});
const load = vi.fn<(id: string) => Promise<void>>(async () => {});

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
  chatSettingsError: () => null,
  loadChatSettings: (id: string) => load(id),
  clearChatSettings: () => clearModes(),
}));
const clearModes = vi.fn();
const clear = vi.fn<(id: string) => Promise<void>>(async () => {});
vi.mock("../lib/twitchAuth", () => ({
  clearChat: (id: string) => clear(id),
}));

const { default: CommandCenter } = await import("./CommandCenter");

const openPanel_ = () =>
  fireEvent.click(screen.getByRole("button", { name: "Chat manager" }));
// Clear chat sits at the foot of the chat modes section.
const openModes = () =>
  fireEvent.click(screen.getByRole("button", { name: /^Chat modes/ }));
const clearButton = () =>
  screen.getByRole("button", { name: /^(Clear chat|Tap again)/ });
const { CLEAR_CONFIRM_MS } = await import("../lib/confirmTap");
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

describe("CommandCenter", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows what modes are on and opens them in place", () => {
    setModes(settings);
    render(() => <CommandCenter />);
    expect(load).toHaveBeenCalledWith("100");
    openPanel_();
    expect(screen.getByText("Your channel")).toBeTruthy();
    const modes = screen.getByRole("button", { name: /^Chat modes/ });
    expect(modes.textContent).toContain("Slow 30s");
    setModes({ ...settings, slow_mode: false });
    expect(modes.textContent).toContain("Open chat");
    fireEvent.click(modes);
    expect(modes.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("complementary").textContent).toContain(
      "Slow mode",
    );
    fireEvent.click(modes);
    expect(modes.getAttribute("aria-expanded")).toBe("false");
  });

  it("follows the channel with the modes and drops them without mod rights", () => {
    render(() => <CommandCenter />);
    expect(load).toHaveBeenLastCalledWith("100");
    setChannel({ id: "200" });
    expect(load).toHaveBeenLastCalledWith("200");
    expect(clearModes).not.toHaveBeenCalled();
    setCanMod(false);
    expect(clearModes).toHaveBeenCalledTimes(1);
    setCanMod(true);
    setChannel({ id: "100" });
  });

  it("clears chat only on a second tap", async () => {
    vi.useFakeTimers();
    try {
      render(() => <CommandCenter />);
      openPanel_();
      openModes();
      fireEvent.click(clearButton());
      expect(clear).not.toHaveBeenCalled();
      expect(clearButton().textContent).toBe("Tap again to clear for everyone");
      vi.advanceTimersByTime(CLEAR_CONFIRM_MS);
      expect(clearButton().textContent).toBe("Clear chat");

      fireEvent.click(clearButton());
      fireEvent.click(clearButton());
      expect(clear).toHaveBeenCalledWith("100");
      await vi.runAllTimersAsync();
      expect(clearButton().textContent).toBe("Clear chat");
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
    render(() => <CommandCenter />);
    openPanel_();
    openModes();
    fireEvent.click(clearButton());
    fireEvent.click(clearButton());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not a moderator",
    );

    clear.mockRejectedValueOnce("sidecar went away");
    fireEvent.click(clearButton());
    fireEvent.click(clearButton());
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("sidecar went away"),
    );
  });

  it("counts held messages for the open channel and shows the queue in place", () => {
    render(() => <CommandCenter />);
    const handle = () => screen.getByRole("button", { name: /Chat manager/ });
    expect(handle().textContent).toBe("");
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
    expect(handle().textContent).toBe("2");
    openPanel_();
    fireEvent.click(screen.getByRole("button", { name: /^AutoMod/ }));
    expect(screen.getAllByText("Chatter")).toHaveLength(2);
    clearHeldMessages();
  });

  it("labels a moderator and stays hidden without the role", () => {
    setChannel({ id: "200" });
    render(() => <CommandCenter />);
    openPanel_();
    expect(screen.getByText("Moderator")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    setCanMod(false);
    expect(screen.queryByRole("button", { name: "Chat manager" })).toBeNull();
    setCanMod(true);
    setChannel({ id: "100" });
  });
});
