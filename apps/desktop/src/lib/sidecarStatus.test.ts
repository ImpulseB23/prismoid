import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { currentSidecarStatus } from "./sidecarStatus";

afterEach(() => {
  invokeMock.mockReset();
});

describe("currentSidecarStatus", () => {
  it("asks the host for its latest status", async () => {
    invokeMock.mockResolvedValueOnce({ state: "running", attempt: 1 });
    await expect(currentSidecarStatus()).resolves.toEqual({
      state: "running",
      attempt: 1,
    });
    expect(invokeMock).toHaveBeenCalledWith("current_sidecar_status");
  });
});
