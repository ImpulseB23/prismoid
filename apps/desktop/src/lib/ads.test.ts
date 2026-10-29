import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { getAdSchedule, snoozeNextAd, startCommercial } from "./ads";

afterEach(() => {
  invokeMock.mockReset();
});

describe("ad commands", () => {
  it("passes arguments the way the host commands name them", async () => {
    invokeMock.mockResolvedValue(null);
    await getAdSchedule();
    await snoozeNextAd();
    await startCommercial(90);
    expect(invokeMock.mock.calls).toEqual([
      ["twitch_get_ad_schedule"],
      ["twitch_snooze_next_ad"],
      ["twitch_start_commercial", { length: 90 }],
    ]);
  });
});
