import { describe, expect, it } from "vitest";
import { bytesLeft, slowModeLeft, timeoutLeft } from "./composerMeta";
import type { ModAction } from "./chatEvents";
import type { ChatSettings } from "./twitchChannel";

const slow = { slow_mode: true, slow_mode_wait_time: 30 } as ChatSettings;

const act = (action: string, t: number, duration: number | null = null) =>
  ({
    channel_id: "1",
    action,
    timestamp: t,
    duration_seconds: duration,
  }) as ModAction;

describe("composerMeta", () => {
  it("counts bytes, not characters", () => {
    expect(bytesLeft("hi")).toBe(498);
    expect(bytesLeft("  é ")).toBe(498);
  });

  it("waits out slow mode unless exempt", () => {
    expect(slowModeLeft(slow, 1_000, 11_000, false)).toBe(20);
    expect(slowModeLeft(slow, 1_000, 40_000, false)).toBe(0);
    expect(slowModeLeft(slow, 1_000, 11_000, true)).toBe(0);
    expect(slowModeLeft(slow, undefined, 11_000, false)).toBe(0);
    expect(slowModeLeft(null, 1_000, 11_000, false)).toBe(0);
  });

  it("follows the latest timeout in the channel", () => {
    expect(timeoutLeft([act("timeout", 0, 60)], "1", 30_000)).toBe(30);
    expect(timeoutLeft([act("timeout", 0, 60)], "2", 30_000)).toBe(0);
    expect(
      timeoutLeft(
        [act("timeout", 0, 60), act("untimeout", 10_000)],
        "1",
        30_000,
      ),
    ).toBe(0);
    expect(timeoutLeft([act("timeout", 0, 60)], "1", 90_000)).toBe(0);
  });
});
