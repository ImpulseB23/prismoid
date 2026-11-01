import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { Channel } from "../lib/twitchChannel";

const offline = {
  secondsLeft: vi.fn<(id: string) => number | null>(() => 272),
  raidOf: vi.fn<(id: string) => { login: string; name: string } | null>(
    () => null,
  ),
  keepOpen: vi.fn(),
};
vi.mock("../stores/offlineStore", () => ({
  offlineSecondsLeft: (id: string) => offline.secondsLeft(id),
  offlineRaidOf: (id: string) => offline.raidOf(id),
  keepEndedChatOpen: (id: string) => offline.keepOpen(id),
}));
const channels = {
  selectChannel: vi.fn(async () => ({}) as Channel),
  closeChannel: vi.fn(async () => {}),
};
vi.mock("../stores/channelStore", () => channels);

const { default: OfflineBar, formatCountdown } = await import("./OfflineBar");

const ended = { id: "1", login: "a", display_name: "A" } as Channel;

describe("OfflineBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows nothing for a live chat or a pane without a channel", () => {
    offline.secondsLeft.mockReturnValueOnce(null);
    render(() => <OfflineBar channel={ended} />);
    render(() => <OfflineBar channel={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts down and keeps the chat open on request", () => {
    render(() => <OfflineBar channel={ended} />);
    expect(screen.getByRole("status").textContent).toContain("Closing in 4:32");
    expect(screen.queryByRole("button", { name: /Go to/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
    expect(offline.keepOpen).toHaveBeenCalledWith("1");
  });

  it("follows the raid and closes the ended chat", async () => {
    offline.raidOf.mockReturnValue({ login: "friend", name: "Friend" });
    render(() => <OfflineBar channel={ended} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to Friend" }));
    await vi.waitFor(() =>
      expect(channels.closeChannel).toHaveBeenCalledWith("1"),
    );
    expect(channels.selectChannel).toHaveBeenCalledWith("friend", {
      remember: true,
    });
    offline.raidOf.mockReturnValue(null);
  });

  it("formats the time left as minutes and seconds", () => {
    expect(formatCountdown(300)).toBe("5:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(0)).toBe("0:00");
  });
});
