import { describe, expect, it, vi } from "vitest";
import { isUninstallError, uninstallApp } from "./uninstall";

const invoke = vi.fn<(cmd: string) => Promise<void>>(async () => {});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));

describe("uninstall", () => {
  it("calls the host command", async () => {
    await uninstallApp();
    expect(invoke).toHaveBeenCalledWith("uninstall_app");
  });

  it("surfaces a missing uninstaller as not_installed", async () => {
    invoke.mockRejectedValueOnce({
      kind: "not_installed",
      message: "no uninstaller at C:\\dev\\uninstall.exe",
    });
    const caught: unknown = await uninstallApp().catch((e: unknown) => e);
    expect(isUninstallError(caught) && caught.kind).toBe("not_installed");
  });

  it("accepts only host error shapes", () => {
    expect(isUninstallError({ kind: "launch_failed", message: "x" })).toBe(
      true,
    );
    expect(isUninstallError({ kind: "files", message: "x" })).toBe(false);
    expect(isUninstallError({ kind: "not_installed" })).toBe(false);
    expect(isUninstallError(new Error("not_installed"))).toBe(false);
    expect(isUninstallError(undefined)).toBe(false);
  });
});
