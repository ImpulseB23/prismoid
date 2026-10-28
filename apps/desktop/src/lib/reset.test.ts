import { describe, expect, it, vi } from "vitest";
import { isResetError, resetAllData, resetSettings } from "./reset";

const invoke = vi.fn<(cmd: string) => Promise<void>>(async () => {});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));

describe("reset", () => {
  it("calls the host commands", async () => {
    await resetSettings();
    expect(invoke).toHaveBeenLastCalledWith("reset_settings");
    await resetAllData();
    expect(invoke).toHaveBeenLastCalledWith("reset_all_data");
  });

  it("passes host errors through", async () => {
    const err = { kind: "sign_out", message: "keychain locked" };
    invoke.mockRejectedValueOnce(err);
    const caught: unknown = await resetAllData().catch((e: unknown) => e);
    expect(isResetError(caught) && caught.kind).toBe("sign_out");
  });

  it("accepts only host error shapes", () => {
    expect(isResetError({ kind: "files", message: "denied" })).toBe(true);
    expect(isResetError({ kind: "other", message: "x" })).toBe(false);
    expect(isResetError({ kind: "files" })).toBe(false);
    expect(isResetError("files")).toBe(false);
    expect(isResetError(null)).toBe(false);
  });
});
