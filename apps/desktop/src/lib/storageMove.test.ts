import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { exportOldStorage, importOldStorage } = await import("./storageMove");

describe("storageMove", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
  });

  it("hands the old origin over and clears it once kept", async () => {
    localStorage.setItem("prismoid.settings", '{"zoom":1.2}');
    invoke.mockResolvedValueOnce(true);
    await exportOldStorage(localStorage);
    expect(invoke).toHaveBeenNthCalledWith(1, "storage_move_export", {
      entries: [["prismoid.settings", '{"zoom":1.2}']],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "storage_move_finish", {
      cleared: true,
    });
    expect(localStorage.length).toBe(0);
  });

  it("keeps the old copy when the main window never took it", async () => {
    localStorage.setItem("prismoid.settings", "{}");
    invoke.mockResolvedValueOnce(false);
    await exportOldStorage(localStorage);
    expect(invoke).toHaveBeenLastCalledWith("storage_move_finish", {
      cleared: false,
    });
    expect(localStorage.getItem("prismoid.settings")).toBe("{}");
  });

  it("writes what was moved without overwriting newer keys", async () => {
    localStorage.setItem("prismoid.ownColor", "#ff0000");
    invoke.mockResolvedValueOnce([
      ["prismoid.settings", '{"zoom":1.2}'],
      ["prismoid.ownColor", "#00ff00"],
    ]);
    await importOldStorage(localStorage);
    expect(localStorage.getItem("prismoid.settings")).toBe('{"zoom":1.2}');
    expect(localStorage.getItem("prismoid.ownColor")).toBe("#ff0000");
    expect(invoke).toHaveBeenLastCalledWith("storage_move_imported");
  });

  it("does nothing when there is nothing to move", async () => {
    invoke.mockResolvedValueOnce(null);
    await importOldStorage(localStorage);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
