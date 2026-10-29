import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  createClip,
  createMarker,
  getClip,
  getPinnedMessage,
  getShieldMode,
  pinMessage,
  sendAnnouncement,
  sendShoutout,
  setShieldMode,
  unpinMessage,
  type QuickActionError,
} from "./quickActions";
import { formatChannelError } from "./twitchChannel";

afterEach(() => {
  invokeMock.mockReset();
});

describe("quick action commands", () => {
  it("passes arguments the way the host commands name them", async () => {
    invokeMock.mockResolvedValue(null);
    await createMarker();
    await createMarker("boss fight");
    await createClip();
    await createClip({ title: "nice", duration: 12.5 });
    await getClip("Slug");
    await sendShoutout("9");
    await sendAnnouncement("hi");
    await sendAnnouncement("hi", "purple");
    await getShieldMode();
    await setShieldMode(true);
    await getPinnedMessage();
    await pinMessage("m");
    await pinMessage("m", 300);
    await unpinMessage("m");

    expect(invokeMock.mock.calls).toEqual([
      ["twitch_create_marker", { description: null }],
      ["twitch_create_marker", { description: "boss fight" }],
      ["twitch_create_clip", { title: null, duration: null }],
      ["twitch_create_clip", { title: "nice", duration: 12.5 }],
      ["twitch_get_clip", { clipId: "Slug" }],
      ["twitch_send_shoutout", { toBroadcasterId: "9" }],
      ["twitch_send_announcement", { message: "hi", color: "primary" }],
      ["twitch_send_announcement", { message: "hi", color: "purple" }],
      ["twitch_get_shield_mode"],
      ["twitch_set_shield_mode", { isActive: true }],
      ["twitch_get_pinned_message"],
      ["twitch_pin_message", { messageId: "m", durationSeconds: null }],
      ["twitch_pin_message", { messageId: "m", durationSeconds: 300 }],
      ["twitch_unpin_message", { messageId: "m" }],
    ]);
  });

  it("rejects with the host error", async () => {
    const err: QuickActionError = { kind: "shoutout_cooldown", message: "" };
    invokeMock.mockRejectedValue(err);
    await expect(sendShoutout("9")).rejects.toEqual(err);
  });
});

describe("quick action errors", () => {
  it("explains each kind", () => {
    const cases: [QuickActionError["kind"], RegExp][] = [
      ["not_live", /live/],
      ["marker_unavailable", /VODs/],
      ["shoutout_cooldown", /cooldown/],
      ["shoutout_needs_viewers", /viewer/],
      ["already_pinned", /already pinned/],
    ];
    for (const [kind, text] of cases) {
      expect(formatChannelError({ kind, message: "raw" })).toMatch(text);
    }
  });
});
