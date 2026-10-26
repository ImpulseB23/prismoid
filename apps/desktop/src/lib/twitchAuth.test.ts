import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import {
  banUser,
  deleteMessage,
  sendMessage,
  timeoutUser,
  unbanUser,
  openVerificationUri,
  MAX_CHAT_MESSAGE_BYTES,
} from "./twitchAuth";

afterEach(() => {
  invokeMock.mockReset();
});

describe("sendMessage", () => {
  it("invokes twitch_send_message with the text payload", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await sendMessage("c1", "hello world");
    expect(invokeMock).toHaveBeenCalledWith("twitch_send_message", {
      channelId: "c1",
      text: "hello world",
      replyTo: null,
    });
    invokeMock.mockResolvedValueOnce(undefined);
    await sendMessage("c1", "yes", "parent-1");
    expect(invokeMock).toHaveBeenLastCalledWith("twitch_send_message", {
      channelId: "c1",
      text: "yes",
      replyTo: "parent-1",
    });
  });

  it("propagates the structured error from the backend", async () => {
    const err = { kind: "helix", code: "msg_duplicate", message: "dup" };
    invokeMock.mockRejectedValueOnce(err);
    await expect(sendMessage("c1", "x")).rejects.toEqual(err);
  });

  it("exposes the byte cap matching the Rust constant", () => {
    expect(MAX_CHAT_MESSAGE_BYTES).toBe(500);
  });
});

describe("moderation commands", () => {
  it("invokes twitch_ban_user", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await banUser("c1", "u1", "spam");
    expect(invokeMock).toHaveBeenCalledWith("twitch_ban_user", {
      channelId: "c1",
      targetUserId: "u1",
      reason: "spam",
    });
  });

  it("invokes twitch_unban_user", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await unbanUser("c1", "u1");
    expect(invokeMock).toHaveBeenCalledWith("twitch_unban_user", {
      channelId: "c1",
      targetUserId: "u1",
    });
  });

  it("invokes twitch_timeout_user", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await timeoutUser("c1", "u1", 60, "caps");
    expect(invokeMock).toHaveBeenCalledWith("twitch_timeout_user", {
      channelId: "c1",
      targetUserId: "u1",
      durationSeconds: 60,
      reason: "caps",
    });
  });

  it("invokes twitch_delete_message", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteMessage("c1", "m1");
    expect(invokeMock).toHaveBeenCalledWith("twitch_delete_message", {
      channelId: "c1",
      messageId: "m1",
    });
  });
});

describe("openVerificationUri", () => {
  it("allows a valid Twitch verification URL", async () => {
    await expect(
      openVerificationUri("https://www.twitch.tv/activate"),
    ).resolves.toBeUndefined();
  });

  it("rejects non-Twitch hosts", async () => {
    await expect(openVerificationUri("https://evil.com/phish")).rejects.toThrow(
      "verification URL not on a Twitch domain",
    );
  });

  it("rejects http URLs", async () => {
    await expect(
      openVerificationUri("http://www.twitch.tv/activate"),
    ).rejects.toThrow("verification URL not on a Twitch domain");
  });

  it("rejects invalid URLs", async () => {
    await expect(openVerificationUri("not-a-url")).rejects.toThrow(
      "invalid verification URL",
    );
  });
});
